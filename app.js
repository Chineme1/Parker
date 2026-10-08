// app.js — UI controller.

import { IMAGERY, OCCUPANCY, OverpassGeometry, imageryUrl, getKey, setKey } from './providers.js';
import { analyse, applyOccupancy } from './parking.js';
import { haversine } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const SETTINGS_KEY = 'parker.settings';
const ENTRANCE_KEY = 'parker.entrances';
// Cap on drawn candidates. A mall lot can synthesise several thousand.
const MAX_DRAWN = 700;

const settings = Object.assign(
  { imagery: 'esri', occupancy: 'none', spacing: 10, radius: 300, rerouteSeconds: 25,
    stallOffset: 6.4, stallDepth: 5.4 },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'),
);
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

const state = {
  map: null,
  tileLayer: null,
  layers: null,
  result: null,
  destination: null,
  destinationId: null,
  target: null,
  watchId: null,
  userLL: null,
  userMarker: null,
  rerouteTimer: null,
  busy: false,
};

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap() {
  // Canvas renderer: a mall lot can synthesise a few thousand stall boxes,
  // which the default SVG renderer will not draw smoothly on a phone.
  state.map = L.map('map', { zoomControl: false, attributionControl: true, preferCanvas: true })
    .setView([34.0633, -117.6509], 13); // Ontario, CA
  L.control.zoom({ position: 'bottomleft' }).addTo(state.map);
  state.layers = L.layerGroup().addTo(state.map);
  applyImagery();
}

function applyImagery() {
  const provider = IMAGERY.find((p) => p.id === settings.imagery) || IMAGERY[0];
  const url = imageryUrl(provider);
  if (state.tileLayer) state.map.removeLayer(state.tileLayer);
  if (!url) {
    toast('That imagery provider has no URL set yet. Open settings to add one.');
    return;
  }
  state.tileLayer = L.tileLayer(url, {
    attribution: provider.attribution,
    maxNativeZoom: provider.maxNativeZoom,
    maxZoom: 21,
    crossOrigin: true,
  }).addTo(state.map);
}

// ---------------------------------------------------------------------------
// Destination search
// ---------------------------------------------------------------------------

async function search(query) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}

function renderResults(results) {
  const list = $('#results');
  list.innerHTML = '';
  if (!results.length) {
    list.innerHTML = '<li class="empty">Nothing found. Try adding the city.</li>';
    list.hidden = false;
    return;
  }
  for (const r of results) {
    const li = document.createElement('li');
    const main = r.name || r.display_name.split(',')[0];
    const rest = r.display_name.split(',').slice(1, 3).join(',').trim();
    li.innerHTML = `<b>${escapeHtml(main)}</b><span>${escapeHtml(rest)}</span>`;
    li.addEventListener('click', () => {
      list.hidden = true;
      $('#q').value = main;
      go({ lat: +r.lat, lng: +r.lon }, main, `${r.osm_type}/${r.osm_id}`);
    });
    list.appendChild(li);
  }
  list.hidden = false;
}

// ---------------------------------------------------------------------------
// The main flow
// ---------------------------------------------------------------------------

async function go(ll, label, id) {
  if (state.busy) return;
  state.busy = true;
  state.destination = ll;
  state.destinationId = id || `${ll.lat.toFixed(5)},${ll.lng.toFixed(5)}`;
  state.target = null;
  setStatus(`Reading the lot around ${label}…`);
  state.map.setView([ll.lat, ll.lng], 18);

  try {
    const features = await OverpassGeometry.fetchArea(ll, settings.radius);
    const overrides = JSON.parse(localStorage.getItem(ENTRANCE_KEY) || '{}');
    const result = analyse(features, ll, {
      spacing: settings.spacing,
      entranceOverride: overrides[state.destinationId] || null,
      stall: { offset: settings.stallOffset, depth: settings.stallDepth },
    });
    result.label = label;
    state.result = result;

    if (!result.candidates.length) {
      draw(result, true);
      setStatus('');
      sheetMessage(
        'No parking mapped here',
        `OpenStreetMap has ${result.diagnostics.lotsFound} lot(s) and ` +
          `${result.diagnostics.aislesFound} aisle(s) within ${settings.radius} m of this ` +
          `point, and none of them line up with the destination. Try a wider radius in ` +
          `settings, or pick a different branch.`,
      );
      return;
    }

    await refreshOccupancy(result, { quiet: true });
    state.target = result.candidates[0];
    draw(result, true);
    renderSheet(result);
    setStatus('');
    startRerouteLoop();
  } catch (err) {
    setStatus('');
    sheetMessage('Could not read the lot', err.message);
  } finally {
    state.busy = false;
  }
}

async function refreshOccupancy(result, { quiet = false } = {}) {
  const provider = OCCUPANCY.find((p) => p.id === settings.occupancy) || OCCUPANCY[0];
  try {
    const reading = await provider.read(result.candidates.slice(0, 200));
    applyOccupancy(result.candidates, reading);
    result.occupancyLabel = provider.label;
    result.occupancyLive = provider.live;
  } catch (err) {
    if (!quiet) toast(`Occupancy feed failed: ${err.message}`);
    result.occupancyLabel = 'Unavailable';
    result.occupancyLive = false;
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function draw(result, fit = false) {
  state.layers.clearLayers();
  const bounds = [];

  for (const lot of result.lots) {
    L.polygon(lot.ring, {
      color: '#9fb0c0', weight: 1, opacity: 0.7, fill: true,
      fillColor: '#6e869c', fillOpacity: 0.12, interactive: false,
    }).addTo(state.layers);
    lot.ring.forEach((p) => bounds.push([p.lat, p.lng]));
  }

  if (result.building) {
    L.polygon(result.building.ring, {
      color: '#f5f7fa', weight: 1.5, opacity: 0.85, fill: true,
      fillColor: '#f5f7fa', fillOpacity: 0.16, interactive: false,
    }).addTo(state.layers);
  }

  // Ranked spots: the pick is loud, the runners-up are quiet. Where stalls have
  // real outlines they are drawn as boxes; otherwise as dots.
  const shown = result.candidates.slice(0, MAX_DRAWN);
  shown.forEach((c, i) => {
    if (c === state.target) return;
    const known = c.occupancy;
    const stroke = known ? (known.free ? '#34d27b' : '#f2555a') : '#cfd8e3';
    const near = i < 24;
    if (c.ring) {
      L.polygon(c.ring, {
        color: stroke,
        weight: 1,
        opacity: known ? 0.9 : near ? 0.6 : 0.35,
        fillColor: stroke,
        fillOpacity: known ? 0.4 : near ? 0.22 : 0.1,
        interactive: near,
      })
        .addTo(state.layers)
        .on('click', () => selectTarget(c));
    } else {
      L.circleMarker([c.ll.lat, c.ll.lng], {
        radius: near ? 5 : 3.5,
        color: stroke,
        weight: 1.5,
        opacity: known ? 0.95 : 0.55,
        fillColor: stroke,
        fillOpacity: known ? 0.55 : 0.3,
      })
        .addTo(state.layers)
        .on('click', () => selectTarget(c));
    }
  });

  if (state.target) {
    const t = state.target;
    bounds.push([t.ll.lat, t.ll.lng]);
    if (t.ring) {
      L.polygon(t.ring, {
        color: '#f2c14e', weight: 2, opacity: 1,
        fillColor: '#f2c14e', fillOpacity: 0.75, interactive: false,
      }).addTo(state.layers);
    }
    L.marker([t.ll.lat, t.ll.lng], {
      icon: L.divIcon({ className: 'pin-spot', html: '<i></i>', iconSize: [34, 34] }),
      zIndexOffset: 500,
    }).addTo(state.layers);
  }

  const e = result.entrance;
  bounds.push([e.ll.lat, e.ll.lng]);
  const entranceMarker = L.marker([e.ll.lat, e.ll.lng], {
    icon: L.divIcon({ className: 'pin-door', html: '<i></i>', iconSize: [26, 26] }),
    draggable: true,
    zIndexOffset: 400,
  }).addTo(state.layers);
  entranceMarker.on('dragend', (ev) => {
    const ll = ev.target.getLatLng();
    const store = JSON.parse(localStorage.getItem(ENTRANCE_KEY) || '{}');
    store[state.destinationId] = { lat: ll.lat, lng: ll.lng };
    localStorage.setItem(ENTRANCE_KEY, JSON.stringify(store));
    toast('Entrance moved. Re-ranking.');
    go(state.destination, result.label, state.destinationId);
  });

  // Only frame the map on a fresh destination. Re-drawing from the re-route
  // loop or a tap must never move the view out from under someone driving.
  if (fit) {
    if (state.userLL) bounds.push([state.userLL.lat, state.userLL.lng]);
    if (bounds.length) state.map.fitBounds(bounds, { padding: [40, 180], maxZoom: 19 });
  }
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

function renderSheet(result) {
  const t = state.target;
  if (!t) return;
  const e = result.entrance;

  const sourceNote = {
    stalls: 'Individual stalls are mapped here, so these are real parking spaces.',
    synthesized: 'Stalls estimated by striping off the mapped aisles. The box is where a stall should be, not a confirmed one.',
    aisles: 'Ranked along mapped parking aisles — park on this aisle, near this end.',
    grid: 'Only the lot outline is mapped, so this is the best point in the lot, not a stall.',
  }[result.source];

  const occ = t.occupancy;
  const occLine = occ
    ? `<span class="chip ${occ.free ? 'ok' : 'bad'}">${occ.free ? 'reported free' : 'reported taken'}</span>`
    : '<span class="chip">availability unknown</span>';

  const demoBadge =
    settings.occupancy === 'demo'
      ? '<p class="warn">Simulated availability — these green and red dots are invented, for testing the re-route flow only.</p>'
      : '';

  $('#sheet').innerHTML = `
    <div class="grab"></div>
    <p class="walk"><b>${Math.round(t.walk)}</b><span>m walk to the door</span></p>
    <p class="sub">${escapeHtml(result.label)} · entrance ${e.confidence}
      <button class="link" id="why">why?</button></p>
    <div class="chips">${occLine}<span class="chip">${result.candidates.length} spots considered</span></div>
    ${demoBadge}
    <div class="actions">
      <button id="navigate" class="primary">Navigate to this spot</button>
      <button id="next" class="ghost">Next best</button>
    </div>
    <p class="note">${sourceNote}</p>
  `;

  $('#navigate').addEventListener('click', () => navigateTo(t));
  $('#next').addEventListener('click', () => {
    const i = result.candidates.indexOf(state.target);
    selectTarget(result.candidates[(i + 1) % Math.min(result.candidates.length, 10)]);
  });
  $('#why').addEventListener('click', () => {
    const d = result.diagnostics;
    sheetDialog(
      'How this was worked out',
      `<p>Entrance: <b>${escapeHtml(e.method)}</b>. Drag the white door pin if it is wrong — ` +
        `the correction is remembered for this destination.</p>
       <p>Found within ${settings.radius} m: ${d.lotsFound} parking lot(s) (${d.lotsUsed} close ` +
        `enough to use), ${d.aislesFound} aisle(s), ${d.stallsFound} mapped stall(s), ` +
        `${d.buildingsFound} building(s), ${d.entranceNodes} entrance node(s).</p>
       <p>Ranking is walking distance from each candidate to the entrance, plus a 70 m penalty ` +
        `if the straight line crosses the building. Availability is ${escapeHtml(result.occupancyLabel || 'unknown')}.</p>`,
    );
  });

  $('#sheet').hidden = false;
  updateLiveDistance();
}

function sheetMessage(title, body) {
  $('#sheet').innerHTML = `<div class="grab"></div>
    <p class="walk"><span>${escapeHtml(title)}</span></p>
    <p class="note">${escapeHtml(body)}</p>`;
  $('#sheet').hidden = false;
}

function sheetDialog(title, html) {
  const el = $('#modal');
  el.innerHTML = `<div class="card"><h2>${escapeHtml(title)}</h2>${html}
    <button class="primary" id="closeModal">Close</button></div>`;
  el.hidden = false;
  $('#closeModal').addEventListener('click', () => (el.hidden = true));
}

function selectTarget(c) {
  state.target = c;
  draw(state.result);
  renderSheet(state.result);
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

function navigateTo(c) {
  const url =
    'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
    `${c.ll.lat.toFixed(6)},${c.ll.lng.toFixed(6)}`;
  window.open(url, '_blank', 'noopener');
}

// ---------------------------------------------------------------------------
// Live position
// ---------------------------------------------------------------------------

function startTracking() {
  if (!navigator.geolocation) return toast('This browser has no geolocation.');
  if (state.watchId !== null) return;
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.userLL = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!state.userMarker) {
        state.userMarker = L.marker([state.userLL.lat, state.userLL.lng], {
          icon: L.divIcon({ className: 'pin-you', html: '<i></i>', iconSize: [22, 22] }),
          zIndexOffset: 600,
        }).addTo(state.map);
      } else {
        state.userMarker.setLatLng([state.userLL.lat, state.userLL.lng]);
      }
      updateLiveDistance();
    },
    (err) => toast(`Location unavailable: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
}

function updateLiveDistance() {
  const el = $('#live');
  if (!state.userLL || !state.target) {
    el.hidden = true;
    return;
  }
  const d = haversine(state.userLL, state.target.ll);
  el.hidden = false;
  el.textContent =
    d < 25 ? 'You are at the spot' : `${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'} to the spot`;
}

async function useMyLocation() {
  if (!navigator.geolocation) return toast('This browser has no geolocation.');
  setStatus('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.userLL = ll;
      startTracking();
      go(ll, 'your location', null);
    },
    (err) => {
      setStatus('');
      toast(`Location unavailable: ${err.message}`);
    },
    { enableHighAccuracy: true, timeout: 20000 },
  );
}

// ---------------------------------------------------------------------------
// Re-route loop
// ---------------------------------------------------------------------------

function startRerouteLoop() {
  clearInterval(state.rerouteTimer);
  const provider = OCCUPANCY.find((p) => p.id === settings.occupancy);
  if (!provider || !provider.live) return;

  state.rerouteTimer = setInterval(async () => {
    if (!state.result || !state.target) return;
    await refreshOccupancy(state.result);
    const best = state.result.candidates[0];
    if (!best || best === state.target) return;

    const gain = state.target.score - best.score;
    const stillDriving = !state.userLL || haversine(state.userLL, state.target.ll) > 60;
    if (gain > 15 && stillDriving) {
      offerSwitch(best, gain);
    }
    draw(state.result);
  }, settings.rerouteSeconds * 1000);
}

function offerSwitch(best, gain) {
  const el = $('#toast');
  el.innerHTML = `A spot ${Math.round(gain)} m closer just opened.
    <button id="switchYes">Switch</button><button id="switchNo" class="ghost">Keep</button>`;
  el.hidden = false;
  $('#switchYes').addEventListener('click', () => {
    el.hidden = true;
    selectTarget(best);
    navigateTo(best);
  });
  $('#switchNo').addEventListener('click', () => (el.hidden = true));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function renderSettings() {
  const imageryOpts = IMAGERY.map(
    (p) => `<option value="${p.id}" ${p.id === settings.imagery ? 'selected' : ''}>${p.label}</option>`,
  ).join('');
  const occOpts = OCCUPANCY.map(
    (p) => `<option value="${p.id}" ${p.id === settings.occupancy ? 'selected' : ''}>${p.label}</option>`,
  ).join('');

  const provider = IMAGERY.find((p) => p.id === settings.imagery) || IMAGERY[0];
  const occProvider = OCCUPANCY.find((p) => p.id === settings.occupancy) || OCCUPANCY[0];

  $('#settings').innerHTML = `
    <div class="card">
      <h2>Sources</h2>

      <label>Satellite imagery
        <select id="imagerySel">${imageryOpts}</select>
      </label>
      <p class="note">${escapeHtml(provider.note)}</p>
      ${
        provider.editableUrl
          ? `<label>Tile URL template
               <input id="imageryUrl" placeholder="https://…/{z}/{x}/{y}.jpg?token={key}"
                      value="${escapeHtml(localStorage.getItem('parker.url.' + provider.id) || '')}">
             </label>`
          : ''
      }
      ${
        provider.needsKey
          ? `<label>${escapeHtml(provider.keyLabel || 'API key')}
               <input id="imageryKey" type="password" value="${escapeHtml(getKey(provider.id))}">
             </label>`
          : ''
      }

      <h2>Availability</h2>
      <label>Occupancy source
        <select id="occSel">${occOpts}</select>
      </label>
      <p class="note">${escapeHtml(occProvider.note)}</p>

      <h2>Tuning</h2>
      <label>Search radius around destination: <output id="radOut">${settings.radius}</output> m
        <input type="range" id="rad" min="120" max="700" step="20" value="${settings.radius}">
      </label>
      <label>Candidate spacing along aisles: <output id="spcOut">${settings.spacing}</output> m
        <input type="range" id="spc" min="5" max="25" step="1" value="${settings.spacing}">
      </label>

      <h2>Stall shape</h2>
      <p class="note">Only used where stalls are estimated from aisle centrelines.
        Defaults match standard US striping: a 9 x 18 ft stall either side of a 24 ft lane.
        Widen the offset for angled parking or wider lanes.</p>
      <label>Aisle centreline to stall centre: <output id="offOut">${settings.stallOffset}</output> m
        <input type="range" id="off" min="4" max="9" step="0.1" value="${settings.stallOffset}">
      </label>
      <label>Stall depth: <output id="depOut">${settings.stallDepth}</output> m
        <input type="range" id="dep" min="4" max="7" step="0.1" value="${settings.stallDepth}">
      </label>

      <button class="primary" id="closeSettings">Done</button>
      <p class="note">Lot geometry: ${escapeHtml(OverpassGeometry.note)}</p>
    </div>`;

  $('#imagerySel').addEventListener('change', (e) => {
    settings.imagery = e.target.value;
    saveSettings();
    renderSettings();
    applyImagery();
  });
  $('#occSel').addEventListener('change', (e) => {
    settings.occupancy = e.target.value;
    saveSettings();
    renderSettings();
    if (state.result) {
      refreshOccupancy(state.result).then(() => {
        state.target = state.result.candidates[0];
        draw(state.result);
        renderSheet(state.result);
        startRerouteLoop();
      });
    }
  });
  $('#imageryKey')?.addEventListener('change', (e) => {
    setKey(provider.id, e.target.value.trim());
    applyImagery();
  });
  $('#imageryUrl')?.addEventListener('change', (e) => {
    localStorage.setItem('parker.url.' + provider.id, e.target.value.trim());
    applyImagery();
  });
  $('#rad').addEventListener('input', (e) => {
    settings.radius = +e.target.value;
    $('#radOut').textContent = settings.radius;
    saveSettings();
  });
  $('#spc').addEventListener('input', (e) => {
    settings.spacing = +e.target.value;
    $('#spcOut').textContent = settings.spacing;
    saveSettings();
  });
  $('#off').addEventListener('input', (e) => {
    settings.stallOffset = +e.target.value;
    $('#offOut').textContent = settings.stallOffset;
    saveSettings();
  });
  $('#dep').addEventListener('input', (e) => {
    settings.stallDepth = +e.target.value;
    $('#depOut').textContent = settings.stallDepth;
    saveSettings();
  });
  $('#closeSettings').addEventListener('click', () => {
    $('#settings').hidden = true;
    if (state.destination) go(state.destination, state.result?.label || 'destination', state.destinationId);
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function setStatus(text) {
  const el = $('#status');
  el.textContent = text;
  el.hidden = !text;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initMap();

$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  setStatus('Searching…');
  try {
    renderResults(await search(q));
  } catch (err) {
    toast(err.message);
  } finally {
    setStatus('');
  }
});

$('#here').addEventListener('click', useMyLocation);
$('#gear').addEventListener('click', () => {
  renderSettings();
  $('#settings').hidden = false;
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'settings') $('#settings').hidden = true;
  if (e.target.id === 'modal') $('#modal').hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

startTracking();
