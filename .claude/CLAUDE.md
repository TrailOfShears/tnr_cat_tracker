# TNRTrack — Feature Reference
> Source files: `index.html` (614 lines), `script.js` (2541 lines), `styles.css` (744 lines)
> All line numbers refer to the file noted in each section header.

---

## TABLE OF CONTENTS
1. [Architecture & Storage](#1-architecture--storage)
2. [Data Schema](#2-data-schema)
3. [Initialization & Migration](#3-initialization--migration)
4. [Navigation / Tabs](#4-navigation--tabs)
5. [+ Log Cat Tab — Identity Section](#5--log-cat-tab--identity-section)
6. [+ Log Cat Tab — Observation Fields](#6--log-cat-tab--observation-fields)
7. [+ Log Cat Tab — Location & Maps](#7--log-cat-tab--location--maps)
8. [+ Log Cat Tab — Photos](#8--log-cat-tab--photos)
9. [Save / Edit / Clear Observation](#9-save--edit--clear-observation)
10. [Cats Tab — List & Search](#10-cats-tab--list--search)
11. [Cat Detail Modal](#11-cat-detail-modal)
12. [Edit Cat Profile Modal](#12-edit-cat-profile-modal)
13. [Cat Picker Modal](#13-cat-picker-modal)
14. [Relationships System](#14-relationships-system)
15. [Social Graph Tab](#15-social-graph-tab)
16. [Colonies Tab](#16-colonies-tab)
17. [Colony Territory Map Setup](#17-colony-territory-map-setup)
18. [Colony Observation Map](#18-colony-observation-map)
19. [Stats Tab](#19-stats-tab)
20. [Export](#20-export)
21. [Import / Restore](#21-import--restore)
22. [GPS](#22-gps)
23. [TileMap Engine](#23-tilemap-engine)
24. [Active Colony Badge](#24-active-colony-badge)
25. [Help Modal](#25-help-modal)
26. [UI Helpers — Toast & Save Flash](#26-ui-helpers--toast--save-flash)
27. [Danger Zone](#27-danger-zone)
28. [Pill Component System](#28-pill-component-system)
29. [CSS Design System](#29-css-design-system)

---

## 1. Architecture & Storage

**script.js:28–37** — IndexedDB via Dexie.js (v2 schema):
- `db.version(1)` — tables: `cats` (key: `id`), `observations` (key: `id`, index: `cat_id`), `colonies` (key: `id`), `photos` (key: `key`)
- `db.version(2)` — adds `relationships` table (`++id`, indexed on `catAId`, `catBId`)

**script.js:40** — In-memory `photoCache` Map keeps render functions synchronous while IndexedDB is async.

**script.js:42–82** — Async save/load helpers per table:
- `saveCats()` → `db.cats.bulkPut(cats)`
- `saveObs()` → `db.observations.bulkPut(observations)`
- `saveColonies()` → `db.colonies.bulkPut(colonies)`
- `savePhotoCat(id, dataUrl)` / `loadPhotoCat(id)` / `deletePhotoCat(id)` — per-cat profile photo, stored under key `cat_<id>`
- `savePhotosObs(id, photos[])` / `loadPhotosObs(id)` / `deletePhotosObs(id)` — array of photos per observation, stored under key `obs_<id>`

**script.js:7** — `activeColony` persisted in `localStorage` (`tnr_active_colony`) — only intentional localStorage usage.

---

## 2. Data Schema

**script.js:4–6** — In-memory arrays (sourced from IndexedDB on load):

**`cats[]`**
```
{ id, name, colony, color, sex, age, bio, owner }
```

**`observations[]`**
```
{ id, cat_id, date, time, gps, location, bcs, fixed, trap, health, notes }
```
- `fixed` replaces legacy `neutered` + `eartip` fields (combined into one Yes/No/Unknown)

**`colonies[]`**
```
{ id, name, bounds? }
```
- `bounds`: `{ sw: [lat,lng], ne: [lat,lng], zoom, center: [lat,lng] }`

**`relationships[]`**
```
{ id (autoincrement), catAId, catBId, type }
```
- `type`: `'Friend'` | `'Enemy'` | `'Lover'`
- Normalized: `catAId < catBId` always (`normalizeRel`, script.js:1545)

---

## 3. Initialization & Migration

**script.js:256–270** — `init()` (async):
1. `loadAll()` — reads all tables from IndexedDB
2. `setDateTime()` — pre-fills date/time inputs to now
3. `setupPillListeners()` — attaches pill click handlers
4. `syncColonyDropdowns()`, `renderCats()`, `renderColonies()`, `renderStats()`
5. `updateColonyBadge()`, `checkGPSAvailability()`
6. Attaches `f-colony` change listener → `onFormColonyChange()`

**script.js:84–116** — `loadAll()`:
- Parallel `Promise.all` across all 5 tables
- Runs `migrateFromLocalStorage()` if IndexedDB is empty (one-time migration)
- Runs inline migration: legacy `neutered === 'Yes' || eartip === 'Yes'` → sets `o.fixed = 'Yes'` (script.js:108–115)

**script.js:118–174** — `migrateFromLocalStorage()`:
- Reads old `tnr_cats`, `tnr_obs`, `tnr_colonies` from localStorage
- Detects v3 flat format (cats key present, obs key absent) → calls `migrateFromV3()`
- Migrates all `tnr_photo*` localStorage keys into IndexedDB photos table + photoCache
- Writes all data to IndexedDB; shows toast with migration count

**script.js:176–206** — `migrateFromV3(oldCats)`:
- Splits merged cat+obs flat records into separate `cats[]` / `observations[]`
- Deduplicates cats by name (case-insensitive)
- Moves first legacy photo to cat profile; overflow photos to obs photos

---

## 4. Navigation / Tabs

**index.html:23–28** — 5 tabs: `+ LOG CAT`, `CATS`, `🕸 SOCIAL`, `COLONIES`, `STATS`

**script.js:1314–1325** — `switchTab(tab)`:
- Toggles `.active` class on tabs + views
- Tab names: `'log'`, `'cats'`, `'social'`, `'colonies'`, `'stats'`
- Side effects: `renderCats()`, `renderColonies()`, `renderStats()`, `renderSocialGraph()` called on switch

---

## 5. + Log Cat Tab — Identity Section

**index.html:32–226** — `#view-log` — the primary data entry form.

**index.html:34–38** — Edit-mode banner: purple banner with cancel button, shown when editing an existing observation (`editingObsId !== null`).

**index.html:40–113** — Cat link bar + identity section:
- "Link to known cat" tappable bar → opens cat picker modal
- Identity section fields: Name, Colony (dropdown), Primary Color (pill grid + free text), Sex (pills), Est. Age (pills)
- When a known cat is linked: section gains `.linked` + `.locked` classes — inputs become read-only, green border appears, lock label shown with "Unlink" button

**script.js:941–980** — `linkCat(catId)`:
- Pre-fills all identity fields from cat record
- Pre-fills observation fields (BCS, fixed, trap, health) from most recent observation (script.js:966–977)
- Pre-fills owner field
- Calls `filterTrapPills(catId)` to lock backwards trap transitions
- Calls `onFormColonyChange()` to show/hide colony map

**script.js:982–991** — `unlinkCat()`: clears `linkedCatId`, unlocks identity section, resets primary photo row.

**script.js:993–1010** — `lockIdentitySection(locked)` / `updateCatLinkBar(cat)`: toggle CSS classes and update link bar text/icon.

**Owner field** — `f-owner` input with datalist `f-owner-list`. Options: `Feral`, `Community`, `Owned` + any unique owner values in the current colony. Updated dynamically via `updateOwnerList()` (script.js:770–779).

**Bio field** — free-text textarea `f-bio`, saved to cat record.

---

## 6. + Log Cat Tab — Observation Fields

**index.html:126–182** — Observation-specific fields:

| Field | Type | Notes |
|---|---|---|
| Date / Time | date + time inputs | Auto-set to current datetime on load/clear |
| BCS | pills 1–5 | Body Condition Score |
| Fixed (TNR done?) | pills: Yes / No / Unknown | Replaces old neutered+eartip — script.js:842 |
| Trap Status | pills: Not Trapped / Trapped Today / Released / In Transit / At Clinic / Returned | Forward-locked |
| Health | multi-select pills | Eye Disc., URI, Wound, Mange, Limping, Thin, Pregnant, Healthy |
| Notes | textarea | Free text |

**script.js:235–247** — `filterTrapPills(catId)`: locks pills that represent trap statuses earlier than the cat's current derived status. Prevents logging a regression (e.g., can't set "Not Trapped" if already "At Clinic"). Pill class `.pill-locked` added.

---

## 7. + Log Cat Tab — Location & Maps

**index.html:183–210** — Location section:

**Colony Map Pin** (`#colony-map-section`) — hidden until a colony with saved bounds is selected:
- Canvas element `#log-map` with zoom +/− buttons
- Tapping map places a red pin → auto-fills `f-gps` field
- Shows dashed amber territory boundary overlay
- **script.js:781–831** — `onFormColonyChange()` shows/hides section; `initLogMap(colony)` creates TileMap instance; existing GPS pre-restored as pin on edit

**GPS Input** — free-text `f-gps` field + `📍 GET GPS` button → `getGPS()` (script.js:287–313):
- Uses `navigator.geolocation.getCurrentPosition` with `enableHighAccuracy: true`, 15s timeout
- Reports accuracy in meters on success
- Shows `#gps-note` warning if `file://` protocol or insecure HTTP

**Location Description** — free text `f-location` (human-readable).

---

## 8. + Log Cat Tab — Photos

**index.html:115–124** — Primary Photo (saved to cat profile, not per-observation):
- Camera button (capture=environment) + Gallery button
- Tap thumbnail to remove

**index.html:214–223** — Observation Photos (per-sighting, multiple allowed):
- Camera + Gallery buttons, both support `multiple` file selection
- Tap thumbnail to remove; shows KB estimate below

**script.js:1015–1086** — Photo handling:
- `handlePrimaryPhoto()` — compresses to 600px / 0.65 quality
- `handleObsPhotos()` — compresses each to 800px / 0.7 quality
- `compressImage(dataUrl, maxDim, quality, cb)` — canvas-based JPEG resize (script.js:1040)
- `renderPrimaryPhotoRow()` / `renderObsPhotoRow()` — render thumbnail strips
- `updatePhotoStorageNote()` — shows `N obs photo(s) · ~XKB`

---

## 9. Save / Edit / Clear Observation

**script.js:1091–1183** — `saveObservation()`:
1. Validates name is non-empty
2. Finds or creates cat record (deduplicates by lowercase name match if not linked)
3. Syncs identity fields back to cat record if linked
4. Saves primary photo to cat record
5. Builds obs record; upserts if `editingObsId` set, appends otherwise
6. Saves obs photos
7. Shows save flash with cat name + sighting count
8. Calls `renderCats()`, `renderStats()`, `clearForm()`

**script.js:1188–1248** — `editObservation(obsId)`:
- Closes detail modal, switches to log tab
- Sets `editingObsId`, shows edit banner, changes save button text
- Populates all identity + observation fields including health multi-select
- Restores obs photos from cache
- Calls `onFormColonyChange()` to restore map if applicable

**script.js:1250–1255** — `cancelEdit()`: clears edit state, calls `clearForm()`.

**script.js:1260–1309** — `clearForm()`: resets all fields, pills, photos, maps; reapplies `activeColony` if set.

---

## 10. Cats Tab — List & Search

**index.html:231–248** — `#view-cats`: search input + filter dropdown + `#cats-list`.

**script.js:1335–1386** — `renderCats(search, filter)`:
- Filters by name/color/colony text search
- Filter options: `neutered` (fixed=Yes), `not-neutered` (fixed≠Yes), `trapped` (trap in Trapped Today/In Transit/At Clinic), `health` (has health flags)
- Each card shows: avatar photo or emoji, name, color/sex/age, last seen date, status tags (FIXED / NOT FIXED, colony, obs count)
- Tapping a card → `openDetailModal(catId)`

**script.js:222–231** — `derivedStatus(cat_id)`: scans all observations newest-first, accumulates latest values for `fixed`, `trap`, `health`, `bcs`, `gps`, `location`. Once `fixed=Yes` is seen, it sticks regardless of later observations.

**script.js:216–220** — `latestObs(cat_id)`: returns the single most recent observation by date+time string comparison.

---

## 11. Cat Detail Modal

**index.html:316–319** — `#detail-modal` bottom sheet.

**script.js:1423–1530** — `openDetailModal(catId)`:
- Header: photo, name, color/sex/age, status tags (fixed, owner type, colony), bio text
- Action buttons: New Sighting, Edit Profile, Delete
- **Location History map** (script.js:1476–1529): shown if any observations have GPS data
  - Canvas `#cat-detail-map` (200px tall)
  - Markers fade by age (alpha 1.0 down to 0.3), most recent is size 10, others size 7
  - Tapping a marker shows toast with date + location
  - `fitMarkers()` auto-zooms to fit all points
- **Social / Relationships section** via `buildRelSection(catId)` (script.js:1391–1421): lists related cats with colored badges, "Add Relation" button
- **Observation timeline**: newest-first, each entry shows date/time, fixed badge, trap badge, health badge, BCS, location, GPS link (opens Google Maps), notes, photos

**script.js:1532–1536** — `closeDetailModal()`: removes open class, destroys `catDetailTileMap` to free memory.

---

## 12. Edit Cat Profile Modal

**index.html:437–517** — `#edit-profile-modal`.

**script.js:1680–1786** — Full profile editor:
- Fields: Primary Photo (camera/gallery), Name, Colony (dropdown), Primary Color (pills + text), Sex (pills), Age (pills), Bio (textarea), Owner (datalist)
- Save → `saveEditProfile()` (script.js:1747): updates cat record, saves photo, re-renders cats + stats, refreshes detail modal
- Delete button → `deleteFromEditProfile()` (script.js:1778): calls `deleteCat()`
- `epSetPill()` (script.js:1715) sets correct active pill on open

---

## 13. Cat Picker Modal

**index.html:321–330** — `#cat-picker-modal`.

**script.js:922–936** — `openCatPickerModal()`:
- Disabled if currently editing an observation
- Renders 3-column grid of all cats with circular avatar photo or emoji fallback
- Shows color + sex below name

**script.js:938–939** — `closeCatPickerModal()` / `closeCatPickerIfOutside()`.

---

## 14. Relationships System

**script.js:1545–1576** — Core relationship CRUD:
- `normalizeRel(aId, bId)` (script.js:1545) — ensures `catAId < catBId` for dedup
- `getRelationshipsForCat(catId)` (script.js:1549) — returns `[{ otherId, type }]`
- `upsertRelationship(aId, bId, type)` (script.js:1555) — inserts or updates in DB + in-memory array
- `deleteRelationship(aId, bId)` (script.js:1569) — removes from DB + array

**script.js:1578–1665** — Relation Picker Modal (`#relation-picker-modal`, index.html:519–557):
- **Step 1** (`#rel-picker-step1`): scrollable list of all other cats, sorted by same-colony first then alphabetically. Existing relationships shown with colored badge.
- **Step 2** (`#rel-picker-step2`): shows target cat's photo + name + colony. Buttons: Friend, Enemy, Lover. "Remove" button shown only if relationship exists.
- `saveRelationType(type)` (script.js:1652) — calls upsert/delete then closes modal and refreshes detail view

**script.js:1801–1818** — `deleteCat()` also bulk-deletes all relationships involving that cat (`db.relationships.bulkDelete`).

---

## 15. Social Graph Tab

**index.html:259–290** — `#view-social`:
- Toggle checkbox: "Show all colonies" (default: active colony only)
- Legend: Friend (green), Enemy (red dashed), Lover (purple + heart)
- `#social-graph-wrap` — D3 SVG rendered here
- `#social-graph-empty` / `#social-no-rels` — empty states

**script.js:2383–2537** — Social graph rendering:

**script.js:2385–2391** — `loadD3(cb)`: lazy-loads D3 v7 from unpkg on first use (not bundled).

**script.js:2393–2426** — `renderSocialGraph()`:
- Filters cats to active colony (or all if "show all" checked)
- Shows empty state if no cats or no relationships
- Calls `loadD3()` then `_drawD3Graph()`

**script.js:2428–2537** — `_drawD3Graph(container, graphCats, graphRels)`:
- SVG sized to container width × 1.3 (max 540px tall)
- Pan/zoom via `d3.zoom()` (scale 0.25–5x)
- `clipPath` per node for circular photo clipping
- **Force simulation**: `forceLink` (Friend: distance 110, Lover: 80, Enemy: 200), `forceManyBody` (strength −200), `forceCenter`, `forceCollide` (radius 48)
- **Custom enemy-repel force** (script.js:2464–2477): pushes enemy pairs apart if closer than 250px
- Link rendering: Friend = solid green, Enemy = dashed red, Lover = solid purple + heart emoji on midpoint
- Node rendering: circular photo or emoji + name label below
- Nodes are draggable; clicking opens `openDetailModal()`

---

## 16. Colonies Tab

**index.html:249–257** — `#view-colonies`: add-colony input + button, `#colonies-list`.

**script.js:1823–1851** — `addColony()` / `deleteColony(idx)`:
- Add: deduplicates by lowercase name, pushes `{ name }` to array, saves, syncs dropdowns
- Delete: unassigns all cats in that colony (`cat.colony = ''`), splices array, saves

**script.js:1853–1916** — `renderColonies()`:
- Each colony card shows: name, cat count, fixed count/total, total sightings
- **Collapsible cat list** via `toggleColony(idx)` (script.js:1918) — click card header to expand/collapse (CSS `.colony-card.open`)
- Cats grouped by owner type (Feral → Community → Owned → custom), each group labeled
- Each cat mini-row: circular thumb, name, last seen date, "Fixed" tag — tap opens detail modal
- Action buttons: Set Territory (or "Map Set ✓" if bounds exist), Obs Map, Delete

**script.js:1923–1934** — `syncColonyDropdowns()`: keeps `f-colony` and `active-colony-select` in sync with current colonies array.

---

## 17. Colony Territory Map Setup

**index.html:346–371** — `#colony-map-modal`.

**script.js:686–710** — `openColonyMapSetup(colonyIdx)`:
- Creates `colonyTileMap` TileMap instance on `#colony-setup-map` (300px tall)
- If colony has existing bounds → `fitBounds()`; else tries GPS → falls back to US center (39.5, −98.35)

**script.js:720–744** — `searchColonyMapAddress()`:
- Calls Nominatim geocoding API: `https://nominatim.openstreetmap.org/search`
- Fits map to returned bounding box, shows result name or error

**script.js:746–757** — `saveColonyMapBounds()`:
- Reads current map viewport bounds + zoom + center
- Stores to `col.bounds`, calls `saveColonies()`, refreshes colonies list + dropdowns

---

## 18. Colony Observation Map

**index.html:375–435** — `#colony-overview-map-modal` (full-screen bottom sheet, 340px canvas).

**script.js:2276–2378** — Colony overview map:

**`openColonyOverviewMap(colonyIdx)`** (script.js:2276):
- Populates cat filter dropdown with colony's cats
- Resets all 4 filters; opens modal
- Creates `colonyOverviewMap` TileMap with `onMarkerTap` → `showColonyOverviewPopup()`
- Fits to colony bounds (min zoom 13)

**Filters** (index.html:385–413):
- Cat: specific cat or all
- Status: All / Fixed / Not Fixed
- Health: All / Has Concerns / Appears Healthy
- Show: Latest Sighting Only / All Sightings

**`renderColonyOverviewMap()`** (script.js:2313):
- Applies all 4 filters, builds marker array
- Marker color: green = fixed, red = not fixed, amber = unknown
- Labels each marker with cat name
- Updates count display

**`showColonyOverviewPopup(m)`** (script.js:2359):
- Inline popup below map: cat name, date, location, fixed status
- "View Profile" button → closes map, opens detail modal

---

## 19. Stats Tab

**index.html:291–313** — `#view-stats`.

**script.js:1964–2009** — `renderStats()`:

**Stat grid** (2-column):
- Total Cats, Fixed / TNR Done (green), Not Yet Fixed (red), Total Sightings, Health Flags

**Progress bars**:
- TNR Progress (Fixed): `neutered / total`
- Health Concerns: `healthCats / total`
- Pregnant warning alert if any cats flagged Pregnant

**Per-colony progress bars** via `renderColonyStats()` (script.js:1999): one bar per colony showing fixed/total.

---

## 20. Export

**index.html:297–298** — Export CSV + Export JSON buttons.

**script.js:2014–2038** — `exportCSV()`:
- Headers: Cat ID, Cat Name, Colony, Color, Sex, Age, Bio, Date, Time, BCS, Fixed, Trap Status, Health, Location, GPS, Notes
- One row per observation; cats with zero observations get a data-only row
- RFC-4180 quoting (double-quote escaping)
- Filename: `tnr_export_YYYY-MM-DD.csv`

**script.js:2040–2063** — `exportJSON()`:
- Full export including base64 photos (primary + obs arrays)
- Structure: `{ exported_at, cats[{...catFields, primary_photo, observations[{...obsFields, photos[]}]}], colonies[], stats{} }`
- Filename: `tnr_export_YYYY-MM-DD.json`

---

## 21. Import / Restore

**index.html:300–309** — Import JSON + Import CSV file inputs (hidden, triggered by styled label buttons).

**script.js:2077–2133** — `importJSON(event)`:
- Validates presence of `cats` + `observations` keys
- **Merge strategy** (not replace): cats upserted by `id`, observations upserted by `id`
- Restores base64 photos to photoCache + IndexedDB
- Also merges `colonies` if present
- Toast: `+N new cats, N updated, +N obs, N photos`

**script.js:2135–2194** — `importCSV(event)`:
- Parses via `parseCSV()` (handles RFC-4180 quoted fields)
- Upserts cats by `Cat ID` column; adds observations for each row
- Supports columns: Cat ID, Name, Colony, Colour, Pattern, Sex, Age, Bio, Obs ID, Date, Time, Fixed, Trap Status, Health, BCS, Location, Notes

**script.js:2196–2229** — `parseCSV(text)`: RFC-4180 compliant parser handling quoted commas and escaped double quotes.

---

## 22. GPS

**script.js:281–313** — GPS feature:
- `checkGPSAvailability()` (script.js:281): shows `#gps-note` warning if `file://` or insecure HTTP
- `getGPS()` (script.js:287): requests `getCurrentPosition` with `enableHighAccuracy: true`, 15s timeout; populates `f-gps` with `lat, lng` (6 decimal places); reports accuracy in meters; maps error codes to user-friendly messages

---

## 23. TileMap Engine

**script.js:318–681** — `class TileMap` — self-contained OpenStreetMap tile renderer on `<canvas>`:

**Constructor options**: `lat`, `lng`, `zoom`, `onPan`, `onTap`, `onMarkerTap`, `showBounds`

**Key methods**:

| Method | Line | Purpose |
|---|---|---|
| `setView(lat, lng, zoom)` | 376 | Fly to location |
| `fitBounds(sw, ne, minZ)` | 383 | Zoom to fit bounding box |
| `setMarkers(markers[])` | 397 | Replace marker array + redraw |
| `fitMarkers(markers[], minZ)` | 399 | Auto-zoom to fit all markers |
| `zoom_(delta, aroundX, aroundY)` | 414 | Zoom preserving point under cursor |
| `setPin(lat, lng)` | 428 | Place single red drop-pin |
| `canvasToLatLng(cx, cy)` | 358 | Screen to geographic coords |
| `latLngToCanvas(lat, lng)` | 363 | Geographic to screen coords |
| `getBounds()` | 370 | Returns `{ sw, ne }` of current viewport |
| `destroy()` | 342 | Disconnect ResizeObserver + remove event listeners |

**Tile loading** (script.js:434–446): loads from `{a,b,c}.tile.openstreetmap.org`, converts to `ImageBitmap` for GPU-accelerated draw. Caches by URL in `_tiles` Map.

**Rendering** (script.js:448–561):
- Tiles: drawn from cache or gray placeholder with tile coordinates
- "Coordinates work offline" overlay shown when any tiles missing
- `showBounds`: amber dashed rectangle overlay
- Single pin: red circle + drop shadow + stem line
- Multi-markers: colored circles with optional label badge, alpha support for fading older markers
- OSM attribution watermark always rendered

**Input handling** (script.js:584–679): mouse drag, wheel scroll, touch drag, pinch-to-zoom (30%/77% ratio thresholds). Tap vs drag distinguished by 3px movement threshold. `onMarkerTap` fires if tap is within marker radius+8px; falls through to `onTap` otherwise.

**DPR handling** (script.js:563–577): `ResizeObserver` on parent element. Sets `canvas.width/height` in physical pixels, applies `setTransform(dpr, 0, 0, dpr, 0, 0)` so all drawing coords are in CSS pixels.

**`tileMapZoom(map, delta)`** (script.js:681): global helper called by +/− zoom buttons.

---

## 24. Active Colony Badge

**index.html:17** — Colony badge in header: shows active colony name or "NO COLONY". Tapping opens colony picker modal.

**script.js:1939–1959** — Colony picker modal (`#colony-modal`):
- `openColonyPicker()`: syncs dropdown, sets current value, opens modal
- `setActiveColony(val)`: updates `activeColony`, persists to localStorage, updates badge + form dropdown + map section

---

## 25. Help Modal

**index.html:559–596** — `#help-modal`:
- Sections: Getting Started, + Log Cat Tab, Cats Tab, Cat Detail, Tips
- Opened via `openHelp()` (script.js:1538), closed via `closeHelp()` / tap outside

---

## 26. UI Helpers — Toast & Save Flash

**script.js:2256–2261** — `showSaveFlash(name, sub)`:
- Full-screen green overlay with cat name + sub-message (e.g., "Sighting #3 saved")
- Auto-hides after 1800ms

**script.js:2264–2271** — `showToast(msg)`:
- Bottom-center floating pill; auto-hides after 2400ms
- Timer reset on each call (debounced)

---

## 27. Danger Zone

**script.js:2234–2251** — `clearAll()`:
- Double-confirm dialog
- Clears all 5 IndexedDB tables + photoCache
- Resets all in-memory arrays
- Calls `renderCats()`, `renderColonies()`, `renderStats()`, `updateColonyBadge()`, `clearForm()`

---

## 28. Pill Component System

**script.js:836–917** — `setupPillListeners()`:

**Single-select pill groups** (toggle off if re-clicked):
- `pg-color` → `f-color` (text input synced both ways)
- `pg-sex` → `f-sex`
- `pg-age` → `f-age`
- `pg-bcs` → `f-bcs`
- `pg-fixed` → `f-fixed`
- `pg-trap` → `f-trap`

**Multi-select pill group**:
- `pg-health` → `f-health` (comma-separated; uses `healthSelections` Set — script.js:13)

**Edit profile modal pill groups** (script.js:867–887):
- `ep-pg-color` → `ep-color`
- `ep-pg-sex` → `ep-sex`
- `ep-pg-age` → `ep-age`

**Helpers**:
- `setPillValue(groupId, val)` (script.js:901) — activates matching pill
- `setMultiPillValues(groupId, vals)` (script.js:907) — activates multiple pills from CSV string, syncs `healthSelections`

---

## 29. CSS Design System

**styles.css:1–30** — CSS custom properties (`:root`):

| Variable | Value | Usage |
|---|---|---|
| `--bg` | `#0f1117` | Page background |
| `--surface` | `#1a1d27` | Card / input background |
| `--surface2` | `#232636` | Elevated surface |
| `--border` | `#2e3248` | Borders |
| `--accent` | `#f0a500` | Amber — primary CTA, active pills |
| `--accent2` | `#e05c5c` | Red — danger, not-fixed, health flags |
| `--green` | `#3fcf6e` | Fixed / healthy states |
| `--purple` | `#7b6fe0` | Edit mode, relationships |
| `--purple-light` | `#a89ee8` | Purple text on dark |
| `--text` | `#eef0f8` | Body text |
| `--muted` | `#7b819e` | Secondary text, labels |
| `--font` | Syne | Headings (800), labels (600) |
| `--mono` | IBM Plex Mono | Metadata, badges, coordinates |

**Layout**: `max-width: 480px`, centered, `min-height: 100dvh`, flex column. `touch-action: none` on map canvases.

**Key component classes**:
- `.pill` / `.pill.active` / `.pill.green.active` / `.pill.red.active` / `.pill-locked`
- `.cat-card`, `.cat-avatar`, `.cat-info`, `.cat-tags`, `.tag`
- `.colony-card`, `.colony-card.open` (expand/collapse), `.colony-cats`, `.colony-cat-mini`
- `.obs-entry`, `.obs-entry-header`, `.obs-tags`, `.obs-photos`
- `.modal-overlay` / `.modal-overlay.open`, `.modal` (bottom sheet, border-radius: 20px 20px 0 0)
- `.map-picker-wrap`, `.map-canvas`, `.map-zoom-controls`, `.map-zoom-btn`, `.map-pin-indicator`
- `.rel-row`, `.rel-thumb`, `.rel-badge`, `.rel-picker-cat-row`
- `.stat-box`, `.stat-num`, `.progress-bar-wrap`, `.progress-fill`
- `.save-flash` / `.save-flash.show`, `.toast` / `.toast.show`
- `.identity-section.linked`, `.identity-section.locked`
- `.edit-banner` / `.edit-banner.active`
