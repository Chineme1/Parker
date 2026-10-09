# Parker

Finds the parking position with the shortest walk to a destination's entrance,
then hands off to Google Maps navigation. Installs to an Android home screen as
a PWA — no Play Store, no APK, no build step.

## What it actually does

1. You search a destination ("Costco, Ontario CA").
2. It pulls that area's parking geometry — lot outlines, parking aisles, any
   mapped stalls, the building footprint, and any mapped entrance nodes.
3. Where aisles are mapped but stalls are not, it **synthesises individual
   stalls** by stepping along each aisle centreline at stall pitch and
   offsetting perpendicular to both sides. These draw as oriented boxes.
4. It works out where the **entrance** is: a mapped `entrance=main` node if one
   exists, otherwise the face of the building nearest the main lot, which is
   where big-box doors nearly always are. You can drag the white pin to correct
   it, and the correction is remembered for that destination.
5. It ranks every candidate position by walking distance to that entrance,
   penalising any spot whose straight-line walk would cut through the building.
6. Tap **Navigate** and Google Maps drives you to those coordinates.

## What it does not do, and why

**It does not know what is free right now, and satellite imagery cannot tell
it.** Sentinel-2 is 10 m per pixel — a car is under half a pixel. Commercial
30–50 cm imagery from Maxar or Planet revisits a point roughly once a day, is
frequently clouded, and tasking latency runs hours to days. No satellite API
returns "row 3 spot 14 opened ninety seconds ago", at any price.

So occupancy is a **pluggable layer that ships empty**. The ranking works
without it, because "closest to the door" is a geometry question. Ground
cameras, in-ground sensors, or a venue's own feed can fill it in later; the
interface is in `providers.js` waiting for one.

There is a **Simulated** occupancy source in settings. It invents availability so
you can exercise the re-route flow end to end — a closer spot "opens", you get
offered the switch, navigation updates. It is badged in the UI every time it is
on. Do not demo it to anyone without saying so.

## Getting it on your phone

Geolocation only works on a secure origin. `file://` and `http://192.168.x.x`
will load the app and then silently fail to find you, so it needs real HTTPS.
GitHub Pages is the shortest path.

```bash
cd parker-app
git init && git add . && git commit -m "Parker prototype"
git branch -M main
git remote add origin git@github.com:YOURNAME/parker.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.
Wait about a minute for the first build.

On the Pixel 8, open `https://chineme1.github.io/parker/` in Chrome, then
**⋮ → Add to Home screen**. It installs with an icon, opens fullscreen with no
browser chrome, and keeps your settings and entrance corrections between runs.

For desktop iteration, `python3 -m http.server 8000` in this folder works —
`localhost` counts as a secure origin, so GPS works there too.

## Things to try near you

Search these and check the pin lands where you'd actually want to park:

- **Ontario Mills** — huge lot, many entrances. Good test of whether dragging
  the entrance pin to the door you actually use changes the answer sensibly.
- **Costco Ontario CA** — single dominant entrance, should be the easy case.
- A strip mall near you — tests the fallback when aisles are not mapped.
- Somewhere rural — tests the "nothing mapped here" message.

Tap **why?** in the bottom sheet to see exactly what was found and which
entrance method fired. That panel is the fastest way to tell "the model is
wrong" from "OpenStreetMap has no aisles here".

## Adding a satellite source

Append one object to `IMAGERY` in `providers.js`:

```js
{
  id: 'maxar',
  label: 'Maxar SecureWatch',
  note: 'Paid. 30 cm.',
  url: 'https://securewatch.example/earthservice/tms/1.0.0/layer/{z}/{x}/{y}.jpg?key={key}',
  attribution: '© Maxar',
  maxNativeZoom: 20,
  needsKey: true,
  keyLabel: 'SecureWatch key',
}
```

`{key}` is filled from whatever you paste into settings, which is stored in
localStorage and never committed. For a one-off you don't even need to edit
code: pick **Custom XYZ endpoint** in settings and paste the template there.

## Adding an availability source

```js
import { httpOccupancyProvider, OCCUPANCY } from './providers.js';

OCCUPANCY.push(httpOccupancyProvider({
  id: 'lot-cameras',
  label: 'My lot cameras',
  endpoint: 'https://your-api.example/occupancy',
  note: 'Stall classifier on the camera feed.',
}));
```

Your endpoint receives `{spots: [{id, lat, lng}]}` and returns
`[{id, free, conf}]`. Anything you omit is treated as unknown rather than
guessed. Known-taken spots sink to the bottom of the ranking; known-free spots
get a small boost over unknown ones.

## Files

| file | what's in it |
|---|---|
| `index.html` | shell |
| `styles.css` | all styling |
| `app.js` | UI, map, search, re-route loop |
| `parking.js` | entrance estimation and spot ranking |
| `geo.js` | projection and polygon maths |
| `providers.js` | the three provider registries |
| `sw.js` | service worker (caches the shell, never the data) |

## How stalls are synthesised

Defaults come from standard US surface-lot striping: a 9 x 18 ft stall either
side of a 24 ft two-way drive lane. That puts a stall centre 6.4 m from the
aisle centreline, which also makes neighbouring aisles tile correctly — two
aisles at the usual 18.3 m bay pitch produce facing rows that sit back to back
with no gap and no overlap, exactly as a real lot is painted.

A synthesised stall is thrown away if it falls outside the lot polygon (a
perimeter aisle with parking on one side only), lands inside a building (an
aisle running along a storefront), or lands within a drive lane of another
aisle (aisles mapped closer together than a full bay). What survives is then
de-duplicated against its neighbours, since two aisles can both claim the same
tarmac where they meet.

Both the offset and the stall depth are sliders in settings, because angled
parking and wider lanes break the defaults. If the boxes at a lot near you sit
visibly off the painted lines, that is the dial to turn — and it is worth
turning it against a lot you know before trusting it on one you don't.

The boxes are **where a stall should be**, not a confirmed stall. The sheet says
so whenever this mode is active.

## Known limits

- Ranking is straight-line walking distance plus a building-crossing penalty,
  not a true pedestrian path. It will occasionally prefer a spot across an
  aisle you'd rather not cross on foot.
- Inner rings of multipolygon lots (traffic islands) are ignored, so a handful
  of candidates can land on a planter.
- Stall synthesis assumes 90-degree parking. Angled bays will come out roughly
  the right place but the wrong shape, and herringbone lots will look wrong.
- Nothing detects accessible, compact, EV, or reserved stalls. Every box is
  treated as an ordinary spot.
- Where no aisles are mapped it grids the lot outline, and those points are
  "a good area of the lot", not stalls. The sheet says so when this happens.
- Nominatim and Overpass are free community services with rate limits. Fine for
  one person testing; anything real needs your own Overpass instance or a
  pre-baked lot database.
- Esri's free imagery is for evaluation. Production use needs a license, which
  is part of why the provider registry exists.
