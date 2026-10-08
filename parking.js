// parking.js — turn raw map features into a ranked list of places to park.
//
// The ranking question is "which reachable point in this lot leaves the
// shortest walk to the door", which is pure geometry and works whether or not
// anyone knows what is currently free. Occupancy, when a provider supplies it,
// re-weights that list rather than replacing it.

import {
  projection, dist, pointInPolygon, segmentCrossesPolygon, polygonArea,
  centroid, nearestOnPolyline, sampleLine, sampleLineWithTangent, dedupe,
  bearing, compass, stripClosing, bbox, inBbox,
} from './geo.js';

/** How far outside the wall the door actually is. Keeps the entrance point off
 *  the building outline, so a walk that never leaves the lot is not counted as
 *  passing through the store. */
const DOOR_STANDOFF = 2.5;

/** Stall geometry, in metres, from the US surface-lot conventions most big-box
 *  lots are striped to (roughly a 9 x 18 ft stall either side of a 24 ft
 *  two-way drive lane).
 *
 *  `offset` is the one that matters: centreline to stall centre is half the
 *  drive lane plus half the stall depth. It also makes adjacent aisles tile
 *  correctly — two aisles 18.3 m apart put their facing rows back to back with
 *  no gap and no overlap, which is exactly how real lots are striped. */
const STALL = {
  pitch: 2.7,        // stall width, along the aisle
  depth: 5.4,        // stall depth, perpendicular to the aisle
  offset: 6.4,       // aisle centreline to stall centre
  aisleClear: 4.2,   // a "stall" this close to another aisle is really tarmac
};

const ENTRANCE_PRIORITY = { main: 0, customers: 1, yes: 2, entrance: 3 };

/**
 * @param features  output of a geometry provider (lat/lng space)
 * @param destination {lat, lng} the POI the user searched for
 * @param opts {spacing, maxLotDistance, entranceOverride}
 */
export function analyse(features, destination, opts = {}) {
  const spacing = opts.spacing ?? 10;
  const maxLotDistance = opts.maxLotDistance ?? 220;
  const proj = projection(destination);
  const here = { x: 0, y: 0 };

  const toXY = (ring) => stripClosing(ring.map((p) => proj.fwd(p)));

  const buildings = features.buildings.map((b) => ({ ...b, poly: toXY(b.ring) }));
  const lots = features.lots.map((l) => ({ ...l, poly: toXY(l.ring) }));
  const aisles = features.aisles.map((a) => ({ ...a, pts: toXY(a.line) }));
  const spaces = features.spaces.map((s) => ({ ...s, poly: toXY(s.ring) }));
  const entranceNodes = features.entrances.map((e) => ({ ...e, pt: proj.fwd(e.at) }));

  // --- which building is the destination -----------------------------------
  let building =
    buildings.find((b) => b.poly.length > 2 && pointInPolygon(here, b.poly)) || null;
  if (!building) {
    const near = buildings
      .filter((b) => b.poly.length > 2)
      .map((b) => ({ b, d: dist(here, centroid(b.poly)) }))
      .sort((a, c) => a.d - c.d)[0];
    if (near && near.d < 90) building = near.b;
  }

  // --- which lots are plausibly this destination's --------------------------
  const usableLots = lots
    .filter((l) => l.poly.length > 2)
    .map((l) => {
      // Distance to the nearest edge, except that a lot the destination sits
      // inside is at distance zero. Without this a large lot wrapping the
      // destination measures as hundreds of metres away — the distance to its
      // own far perimeter — and gets discarded, which is exactly backwards.
      const inside = pointInPolygon(here, l.poly);
      const outline = nearestOnPolyline(here, l.poly, true);
      return { ...l, area: polygonArea(l.poly), edgeDistance: inside ? 0 : outline.d };
    })
    .filter((l) => l.area > 150 && l.edgeDistance < maxLotDistance)
    .sort((a, b) => a.edgeDistance - b.edgeDistance);

  // --- the entrance ---------------------------------------------------------
  const entrance = resolveEntrance({
    override: opts.entranceOverride ? proj.fwd(opts.entranceOverride) : null,
    building,
    entranceNodes,
    lots: usableLots,
    fallback: here,
  });

  // --- candidate parking positions -----------------------------------------
  let candidates = [];
  let source = 'none';

  const spacesInLots = spaces.filter(
    (s) => s.poly.length > 2 && usableLots.some((l) => pointInPolygon(centroid(s.poly), l.poly)),
  );

  if (spacesInLots.length >= 4) {
    // Best case: someone mapped individual stalls.
    source = 'stalls';
    candidates = spacesInLots.map((s, i) => ({ id: `space-${i}`, pt: centroid(s.poly) }));
  } else {
    const lotAisles = aisles.filter(
      (a) => a.pts.length >= 2 &&
        a.pts.some((p) => usableLots.some((l) => pointInPolygon(p, l.poly))),
    );

    // Normal case: aisles are mapped. Stripe stalls off them.
    const stalls = lotAisles.length
      ? synthesizeStalls(lotAisles, usableLots, buildings, opts.stall || {})
      : [];

    if (stalls.length >= 4) {
      source = 'synthesized';
      candidates = stalls.map((s, i) => ({ id: `stall-${i}`, pt: s.pt, poly: s.poly }));
    } else if (lotAisles.length) {
      // Synthesis produced nothing usable (odd lot shape, angled parking).
      // Fall back to points on the centreline itself.
      const aislePts = [];
      for (const a of lotAisles) {
        for (const p of sampleLine(a.pts, spacing)) {
          if (usableLots.some((l) => pointInPolygon(p, l.poly))) aislePts.push(p);
        }
      }
      source = 'aisles';
      candidates = dedupe(aislePts, spacing * 0.8).map((pt, i) => ({ id: `aisle-${i}`, pt }));
    }

    if (!candidates.length && usableLots.length) {
      // Fallback: only the lot outline is known, so grid the interior.
      source = 'grid';
      candidates = gridLots(usableLots, spacing * 1.6).map((pt, i) => ({ id: `grid-${i}`, pt }));
    }
  }

  // --- score ----------------------------------------------------------------
  const blocked = building ? building.poly : null;
  for (const c of candidates) {
    c.walk = dist(c.pt, entrance.pt);
    c.blocked = blocked ? segmentCrossesPolygon(c.pt, entrance.pt, blocked) : false;
    // Walking around a big-box footprint is roughly half its frontage.
    c.score = c.walk + (c.blocked ? 70 : 0);
    c.ll = proj.inv(c.pt);
    c.ring = c.poly ? c.poly.map((p) => proj.inv(p)) : null;
    c.heading = compass(bearing(entrance.pt, c.pt));
  }
  candidates.sort((a, b) => a.score - b.score);

  return {
    proj,
    destination,
    building,
    entrance: { ...entrance, ll: proj.inv(entrance.pt) },
    lots: usableLots,
    aisles,
    candidates,
    source,
    diagnostics: {
      lotsFound: lots.length,
      lotsUsed: usableLots.length,
      aislesFound: aisles.length,
      stallsFound: spaces.length,
      buildingsFound: buildings.length,
      entranceNodes: entranceNodes.length,
    },
  };
}

/** Nudge a point on the building outline outward, away from the building's
 *  middle, by DOOR_STANDOFF metres. Without this the entrance sits exactly on
 *  the wall, every candidate-to-door segment touches the polygon, and the
 *  "you'd have to walk around the building" penalty fires for everyone. */
function standoff(pt, building) {
  if (!building) return pt;
  const mid = centroid(building.poly);
  const vx = pt.x - mid.x, vy = pt.y - mid.y;
  const len = Math.hypot(vx, vy);
  if (len < 1e-6) return pt;
  return { x: pt.x + (vx / len) * DOOR_STANDOFF, y: pt.y + (vy / len) * DOOR_STANDOFF };
}

/**
 * Turn aisle centrelines into individual stalls by stepping along each aisle at
 * stall pitch and offsetting perpendicular on both sides.
 *
 * Three things disqualify a synthesised stall, and all three happen constantly
 * in real lots:
 *   - it falls outside the lot polygon (perimeter aisle with parking on one
 *     side only — the outer row simply does not exist)
 *   - it lands inside a building (an aisle running along a storefront)
 *   - it lands on another aisle (aisles closer together than a full bay, where
 *     the offset overshoots into the next drive lane)
 */
function synthesizeStalls(aisles, lots, buildings, opts = {}) {
  const pitch = opts.pitch ?? STALL.pitch;
  const depth = opts.depth ?? STALL.depth;
  const offset = opts.offset ?? STALL.offset;
  // A stall centre has to clear any OTHER aisle by half a drive lane plus half
  // a stall, which is the offset itself. Tie it to the offset rather than
  // hard-coding, so tuning the offset keeps the rejection test consistent;
  // the slack absorbs mapping noise in the centrelines.
  const clear = opts.aisleClear ?? Math.max(offset - 0.6, depth / 2);

  const lotBoxes = lots.map((l) => ({ poly: l.poly, box: bbox(l.poly) }));
  const buildingBoxes = buildings.map((b) => ({ poly: b.poly, box: bbox(b.poly) }));
  const aisleBoxes = aisles.map((a) => ({ pts: a.pts, box: bbox(a.pts, clear + 1) }));

  const halfAlong = (pitch / 2) * 0.9; // small gap so stalls read as separate boxes
  const halfDeep = depth / 2;
  const out = [];

  for (const aisle of aisles) {
    if (aisle.pts.length < 2) continue;
    for (const s of sampleLineWithTangent(aisle.pts, pitch)) {
      const nx = -s.ty, ny = s.tx;
      for (const side of [-1, 1]) {
        const c = { x: s.x + nx * offset * side, y: s.y + ny * offset * side };

        if (!lotBoxes.some((l) => inBbox(c, l.box) && pointInPolygon(c, l.poly))) continue;
        if (buildingBoxes.some((b) => inBbox(c, b.box) && pointInPolygon(c, b.poly))) continue;

        let onAnotherAisle = false;
        for (const other of aisleBoxes) {
          if (other.pts === aisle.pts) continue;
          if (!inBbox(c, other.box)) continue;
          if (nearestOnPolyline(c, other.pts).d < clear) { onAnotherAisle = true; break; }
        }
        if (onAnotherAisle) continue;

        const ax = s.tx * halfAlong, ay = s.ty * halfAlong;
        const dx = nx * halfDeep, dy = ny * halfDeep;
        out.push({
          pt: c,
          poly: [
            { x: c.x - ax - dx, y: c.y - ay - dy },
            { x: c.x + ax - dx, y: c.y + ay - dy },
            { x: c.x + ax + dx, y: c.y + ay + dy },
            { x: c.x - ax + dx, y: c.y - ay + dy },
          ],
        });
      }
    }
  }

  // Two aisles can both claim the same strip of tarmac where they meet. A
  // plain grid key misses pairs that straddle a cell boundary, so hash into
  // cells and compare against the eight neighbours as well.
  const minGap = Math.min(pitch, depth) * 0.8;
  const cell = minGap;
  const buckets = new Map();
  const unique = [];
  for (const s of out) {
    const cx = Math.floor(s.pt.x / cell);
    const cy = Math.floor(s.pt.y / cell);
    let clash = false;
    for (let dx = -1; dx <= 1 && !clash; dx++) {
      for (let dy = -1; dy <= 1 && !clash; dy++) {
        for (const other of buckets.get(`${cx + dx}:${cy + dy}`) || []) {
          if (dist(s.pt, other.pt) < minGap) { clash = true; break; }
        }
      }
    }
    if (clash) continue;
    const key = `${cx}:${cy}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
    unique.push(s);
  }
  return unique;
}

function resolveEntrance({ override, building, entranceNodes, lots, fallback }) {
  if (override) {
    return { pt: override, confidence: 'set by you', method: 'manual' };
  }

  // 1. A mapped entrance node sitting on this building's outline.
  if (building) {
    const onBuilding = entranceNodes
      .map((e) => ({ e, d: nearestOnPolyline(e.pt, building.poly, true).d }))
      .filter((r) => r.d < 4)
      .sort(
        (a, b) =>
          (ENTRANCE_PRIORITY[a.e.kind] ?? 9) - (ENTRANCE_PRIORITY[b.e.kind] ?? 9) ||
          a.d - b.d,
      );
    if (onBuilding.length) {
      return {
        pt: standoff(onBuilding[0].e.pt, building),
        confidence: 'mapped',
        method: `OSM entrance=${onBuilding[0].e.kind}`,
      };
    }

    // 2. No mapped door: big-box entrances face the main lot, so take the point
    //    on the building outline closest to that lot's centre of mass.
    if (lots.length) {
      const main = lots.slice().sort((a, b) => b.area - a.area)[0];
      const hit = nearestOnPolyline(centroid(main.poly), building.poly, true);
      return {
        pt: standoff(hit.point, building),
        confidence: 'estimated',
        method: 'building face nearest the main lot',
      };
    }

    return {
      pt: centroid(building.poly),
      confidence: 'rough',
      method: 'building centre — no lot found to orient against',
    };
  }

  return {
    pt: fallback,
    confidence: 'rough',
    method: 'search result coordinates — no building outline found',
  };
}

function gridLots(lots, step) {
  const pts = [];
  for (const lot of lots) {
    const xs = lot.poly.map((p) => p.x);
    const ys = lot.poly.map((p) => p.y);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    for (let x = x0 + step / 2; x < x1; x += step) {
      for (let y = y0 + step / 2; y < y1; y += step) {
        const p = { x, y };
        if (!pointInPolygon(p, lot.poly)) continue;
        if (nearestOnPolyline(p, lot.poly, true).d < 3) continue; // keep off the kerb
        pts.push(p);
      }
    }
  }
  return pts;
}

/** Re-rank an existing candidate list against an occupancy reading. */
export function applyOccupancy(candidates, reading) {
  for (const c of candidates) {
    const obs = reading.get(c.id);
    c.occupancy = obs || null;
    if (!obs) {
      c.score = c.walk + (c.blocked ? 70 : 0);
    } else if (obs.free) {
      c.score = c.walk + (c.blocked ? 70 : 0) - obs.conf * 5;
    } else {
      c.score = c.walk + (c.blocked ? 70 : 0) + 5000; // known-taken sinks to the bottom
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates;
}
