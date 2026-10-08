// geo.js — geometry helpers.
//
// Everything that matters here happens inside one parking lot, a few hundred
// metres across. At that scale a flat local projection in metres is accurate to
// well under a centimetre and makes every other operation trivial, so we
// convert lat/lng to local x/y once per destination and do all the real work
// there.

const M_PER_DEG_LAT = 110574;

/** Build a projection centred on `origin` ({lat, lng}). */
export function projection(origin) {
  const mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return {
    origin,
    fwd(ll) {
      return {
        x: (ll.lng - origin.lng) * mPerDegLng,
        y: (ll.lat - origin.lat) * M_PER_DEG_LAT,
      };
    },
    inv(pt) {
      return {
        lat: origin.lat + pt.y / M_PER_DEG_LAT,
        lng: origin.lng + pt.x / mPerDegLng,
      };
    },
  };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Great-circle distance in metres, for anything outside a single projection. */
export function haversine(a, b) {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p;
  const dLng = (b.lng - a.lng) * p;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Ray-casting point-in-polygon. `poly` is an array of {x, y}. */
export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const hits =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi || 1e-12) + xi;
    if (hits) inside = !inside;
  }
  return inside;
}

function ccw(a, b, c) {
  return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
}

export function segmentsCross(a, b, c, d) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

/** Does the straight walk from a to b pass through this polygon? */
export function segmentCrossesPolygon(a, b, poly) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsCross(a, b, poly[j], poly[i])) return true;
  }
  return false;
}

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(s / 2);
}

/** Overpass returns closed ways with the first node repeated at the end.
 *  Left in place it drags any vertex average toward the ring's start node, so
 *  strip it before doing anything that averages. */
export function stripClosing(ring) {
  if (ring.length > 2) {
    const a = ring[0], b = ring[ring.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) return ring.slice(0, -1);
  }
  return ring;
}

/** Area (not vertex) centroid. Correct for L-shaped and lopsided lots, where a
 *  vertex average drifts toward whichever side was mapped in more detail. */
export function centroid(polyRaw) {
  const poly = stripClosing(polyRaw);
  if (poly.length < 3) {
    let x = 0, y = 0;
    for (const p of poly) { x += p.x; y += p.y; }
    return { x: x / poly.length, y: y / poly.length };
  }
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += cross;
    cx += (poly[j].x + poly[i].x) * cross;
    cy += (poly[j].y + poly[i].y) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    let x = 0, y = 0;
    for (const p of poly) { x += p.x; y += p.y; }
    return { x: x / poly.length, y: y / poly.length };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** Closest point to `pt` on segment ab, plus the distance to it. */
export function nearestOnSegment(pt, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { point: { ...a }, d: dist(pt, a) };
  let t = ((pt.x - a.x) * vx + (pt.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + t * vx, y: a.y + t * vy };
  return { point, d: dist(pt, point) };
}

/** Closest point to `pt` anywhere on a polyline or polygon outline. */
export function nearestOnPolyline(pt, line, closed = false) {
  let best = null;
  const n = closed ? line.length : line.length - 1;
  for (let i = 0; i < n; i++) {
    const a = line[i];
    const b = line[(i + 1) % line.length];
    const hit = nearestOnSegment(pt, a, b);
    if (!best || hit.d < best.d) best = hit;
  }
  return best;
}

/** Walk a polyline dropping a point every `spacing` metres, ends included. */
export function sampleLine(line, spacing) {
  if (line.length < 2) return line.slice();
  const out = [{ ...line[0] }];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const seg = dist(a, b);
    if (seg === 0) continue;
    let t = spacing - carry;
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, y: a.y + ((b.y - a.y) * t) / seg });
      t += spacing;
    }
    carry = (carry + seg) % spacing;
  }
  const last = line[line.length - 1];
  if (dist(out[out.length - 1], last) > spacing * 0.4) out.push({ ...last });
  return out;
}

/** Like sampleLine, but each sample carries the unit tangent of the segment it
 *  sits on. Stall synthesis needs the direction of travel to know which way
 *  "perpendicular" points. */
export function sampleLineWithTangent(line, spacing) {
  const out = [];
  if (line.length < 2) return out;
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg < 1e-9) continue;
    const tx = (b.x - a.x) / seg, ty = (b.y - a.y) / seg;
    let t = spacing - carry;
    let lastPlaced = -carry;
    while (t <= seg) {
      out.push({ x: a.x + tx * t, y: a.y + ty * t, tx, ty });
      lastPlaced = t;
      t += spacing;
    }
    carry = seg - lastPlaced;
  }
  return out;
}

export function bbox(points, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export function inBbox(pt, box) {
  return pt.x >= box.x0 && pt.x <= box.x1 && pt.y >= box.y0 && pt.y <= box.y1;
}

/** Drop near-duplicate points by snapping to a grid of `cell` metres. */
export function dedupe(points, cell) {
  const seen = new Set();
  const out = [];
  for (const p of points) {
    const key = `${Math.round(p.x / cell)}:${Math.round(p.y / cell)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function bearing(from, to) {
  return (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
}

export function compass(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
