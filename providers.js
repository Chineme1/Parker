// providers.js — every external data source the app can use, behind three
// registries. Adding coverage means appending one object to one of these
// arrays; nothing in app.js needs to change.
//
//   IMAGERY    what you see     (satellite tile layers)
//   GEOMETRY   where lots are   (lot outlines, aisles, entrances)
//   OCCUPANCY  what's free      (per-spot availability, optional)
//
// Keys live in localStorage, never in this file.

export function getKey(id) {
  return localStorage.getItem(`parker.key.${id}`) || '';
}
export function setKey(id, value) {
  if (value) localStorage.setItem(`parker.key.${id}`, value);
  else localStorage.removeItem(`parker.key.${id}`);
}

// ---------------------------------------------------------------------------
// IMAGERY
// ---------------------------------------------------------------------------
// Each provider is an XYZ tile source. `url` may contain {z}/{x}/{y} and
// {key}; {key} is substituted from localStorage at layer-build time.
//
// maxNativeZoom is the deepest zoom the service actually has tiles for;
// Leaflet upscales beyond it so the map still zooms smoothly.

export const IMAGERY = [
  {
    id: 'esri',
    label: 'Esri World Imagery',
    note: 'No key. 30–60 cm over most US metros. Good default.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    maxNativeZoom: 19,
    needsKey: false,
  },
  {
    id: 'mapbox',
    label: 'Mapbox Satellite',
    note: 'Needs a public access token (pk.…). Free tier is generous.',
    url: 'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token={key}',
    attribution: '&copy; Mapbox, &copy; Maxar',
    maxNativeZoom: 19,
    needsKey: true,
    keyLabel: 'Mapbox access token',
  },
  {
    id: 'osm',
    label: 'OpenStreetMap (vector reference)',
    note: 'Not satellite. Useful for checking what is actually mapped.',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxNativeZoom: 19,
    needsKey: false,
  },
  {
    id: 'custom',
    label: 'Custom XYZ endpoint',
    note: 'Paste any {z}/{x}/{y} template. Use {key} where the token goes.',
    url: '',
    attribution: 'Custom imagery source',
    maxNativeZoom: 20,
    needsKey: true,
    keyLabel: 'Token (optional)',
    editableUrl: true,
  },
];

export function imageryUrl(provider) {
  let url = provider.editableUrl
    ? localStorage.getItem(`parker.url.${provider.id}`) || ''
    : provider.url;
  return url.replace('{key}', getKey(provider.id));
}

// ---------------------------------------------------------------------------
// GEOMETRY
// ---------------------------------------------------------------------------
// A geometry provider answers: "what parking exists around this point?"
// It returns raw lat/lng features; app.js projects and ranks them.
//
// Contract:
//   async fetchArea({lat, lng}, radiusMetres) -> {
//     lots:      [{ id, name, ring: [{lat,lng}], tags }]
//     aisles:    [{ id, line: [{lat,lng}] }]
//     spaces:    [{ id, ring: [{lat,lng}] }]   // stall-level, usually empty
//     buildings: [{ id, name, ring: [{lat,lng}], tags }]
//     entrances: [{ id, at: {lat,lng}, kind }]
//   }

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

function overpassQuery(lat, lng, radius) {
  const near = `(around:${radius},${lat},${lng})`;
  return `[out:json][timeout:30];
(
  way["amenity"="parking"]${near};
  relation["amenity"="parking"]${near};
  way["service"="parking_aisle"]${near};
  way["amenity"="parking_space"]${near};
  node["entrance"]${near};
  way["building"]${near};
);
out geom;`;
}

const toLL = (g) => g.map((p) => ({ lat: p.lat, lng: p.lon }));

export const OverpassGeometry = {
  id: 'overpass',
  label: 'OpenStreetMap / Overpass',
  note:
    'Lot outlines traced from satellite imagery by OSM mappers. Free, ' +
    'worldwide, no key. Coverage of big-box retail in the US is strong.',

  async fetchArea(center, radius) {
    const body = 'data=' + encodeURIComponent(overpassQuery(center.lat, center.lng, radius));
    let lastErr;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (!res.ok) throw new Error(`${endpoint} returned ${res.status}`);
        return parseOverpass(await res.json());
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`No Overpass mirror responded (${lastErr?.message || 'unknown'})`);
  },
};

function parseOverpass(json) {
  const out = { lots: [], aisles: [], spaces: [], buildings: [], entrances: [] };

  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const id = `${el.type}/${el.id}`;

    if (el.type === 'node' && tags.entrance) {
      out.entrances.push({ id, at: { lat: el.lat, lng: el.lon }, kind: tags.entrance });
      continue;
    }

    if (el.type === 'way' && el.geometry) {
      const ring = toLL(el.geometry);
      if (tags.amenity === 'parking') {
        if (tags.access === 'private' || tags.access === 'no') continue;
        out.lots.push({ id, name: tags.name || null, ring, tags });
      } else if (tags.service === 'parking_aisle') {
        out.aisles.push({ id, line: ring });
      } else if (tags.amenity === 'parking_space') {
        out.spaces.push({ id, ring, tags });
      } else if (tags.building) {
        out.buildings.push({ id, name: tags.name || null, ring, tags });
      }
      continue;
    }

    // Multipolygon lots: treat each outer ring as its own lot. Inner rings
    // (traffic islands) are ignored, which costs us a few metres of accuracy
    // and saves a lot of code.
    if (el.type === 'relation' && tags.amenity === 'parking') {
      if (tags.access === 'private' || tags.access === 'no') continue;
      for (const m of el.members || []) {
        if (m.role === 'outer' && m.geometry && m.geometry.length > 2) {
          out.lots.push({
            id: `${id}/${m.ref}`,
            name: tags.name || null,
            ring: toLL(m.geometry),
            tags,
          });
        }
      }
    }
  }
  return out;
}

export const GEOMETRY = [OverpassGeometry];

// ---------------------------------------------------------------------------
// OCCUPANCY
// ---------------------------------------------------------------------------
// This is the layer satellites cannot fill. Revisit on commercial constellations
// is roughly daily and tasking latency runs hours to days, so an image can tell
// you a lot was busy on Tuesday — never that a spot opened a minute ago.
// Ground cameras, in-ground sensors, or a venue feed can. The interface is
// here so one of those can be dropped in without touching the ranking code.
//
// Contract:
//   async read(candidates) -> Map<candidateId, {free: boolean, conf: number, at: number}>
//   Any candidate left out of the map is treated as unknown.

export const UnknownOccupancy = {
  id: 'none',
  label: 'Unknown (geometry only)',
  note: 'Ranks purely by walking distance to the entrance. Honest default.',
  live: false,
  async read() {
    return new Map();
  },
};

/** Fake availability so the re-routing behaviour can be exercised end to end.
 *  Deterministic per spot so it does not flicker, with a slow churn so you can
 *  watch a closer spot open while driving. Always badged in the UI. */
export const DemoOccupancy = {
  id: 'demo',
  label: 'Simulated (demo only)',
  note: 'Invented data. Exists to test the re-route flow, not to be believed.',
  live: true,
  async read(candidates) {
    const epoch = Math.floor(Date.now() / 25000);
    const map = new Map();
    for (const c of candidates) {
      let h = epoch * 2654435761;
      for (let i = 0; i < c.id.length; i++) h = (h * 31 + c.id.charCodeAt(i)) >>> 0;
      const r = (h % 1000) / 1000;
      map.set(c.id, { free: r > 0.72, conf: 0.5 + Math.abs(r - 0.5) / 2, at: Date.now() });
    }
    return map;
  },
};

/** Template for a real feed. Point it at your own endpoint returning
 *  [{id, free, conf}] and add it to the OCCUPANCY array below. */
export function httpOccupancyProvider({ id, label, endpoint, note = '' }) {
  return {
    id,
    label,
    note,
    live: true,
    async read(candidates) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spots: candidates.map((c) => ({ id: c.id, lat: c.ll.lat, lng: c.ll.lng })),
        }),
      });
      if (!res.ok) throw new Error(`Occupancy feed returned ${res.status}`);
      const map = new Map();
      for (const row of await res.json()) {
        map.set(row.id, { free: !!row.free, conf: row.conf ?? 0.5, at: Date.now() });
      }
      return map;
    },
  };
}

export const OCCUPANCY = [UnknownOccupancy, DemoOccupancy];
