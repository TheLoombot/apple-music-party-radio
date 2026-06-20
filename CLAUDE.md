# Apple Music Party Radio — Claude Code Guide

**Never add `Co-Authored-By:` lines to git commit messages.**
**Never run `npm run deploy` manually — GitHub Actions deploys on push to `main`.**

---

Real-time collaborative radio stations backed by Apple Music. Listeners hear the same track at the same position via **time-based sync** (each client plays independently, no audio stream through the server). Production domain: **hat.fm**. The server is a PartyKit Durable Object; the client is React + MusicKit JS v3.

---

## Architecture

```
party/index.ts          PartyKit Durable Object — all server logic
shared/track.ts         migrateTrack / sameTrack — ONE implementation imported by
                        BOTH party/index.ts and the client. Never fork/mirror these:
                        mirror drift in a migration once wiped station pools.
                        Tested by shared/track.test.ts (`npm test` at repo root).
client/src/
  App.tsx               Root component, all state & handlers
  types.ts              Shared interfaces (Track, QueueItem, Station, ...)
  services/
    partykit.ts         WebSocket singletons (stationSocket, indexSocket)
    playbackLoop.ts     Sync engine — drives MusicKit from queue state
    appleMusicPlayer.ts MusicPlayer impl for Apple Music
    player.ts           MusicPlayer interface + UnavailableError
    musickit.ts         MusicKit JS v3 wrapper (auth, playback, events)
    appleMusic.ts       Apple Music REST API calls
    catalog.ts          MusicCatalog interface + AppleMusicCatalog impl
    identity.ts         localStorage-based user identity (no Firebase)
    frequency.ts        FM band constants + isValidFreqId / pickAvailableFreqId
  components/           React UI (see component list below)
```

### Two PartyKit room types

| Room ID | Purpose |
|---|---|
| `"index"` | Global station registry; HTTP `/create-station`, `/owner` endpoints; handles `register`, `remove_station`, `station_status`, `station_presence` |
| `"<freq>"` (e.g. `"94.5"`) | One station's queue/pool/chat/DJs/ownership |

Station rooms POST to the index room (server-to-server) for `station_status` / `station_presence` pings. Index POSTs to station rooms for `/create` (set ownership at creation) and `/bootstrap` (wake a dormant station).

---

## Station IDs are FM frequencies (post-big-bang model)

There are exactly **100 valid station IDs**: `88.1`, `88.3`, ... `107.9` (step `0.2`).
`client/src/services/frequency.ts` defines the band and exports `isValidFreqId()`, `allFreqIds()`, `pickAvailableFreqId(taken)`. The same constants live in `party/index.ts`.

- **Station id == freq string == PartyKit room name == URL path segment.** Don't introduce separate "slug" vs "frequency" notions — they're the same thing.
- All URL parsing in `App.tsx` is gated on `isValidFreqId(...)` — anything else falls through to the "no station" state.
- Schema 1 → 2 migration in the index drops any non-frequency station ids on first boot (legacy slug rooms).
- Both `handleIndex` register and `POST /parties/main/index` station_status reject non-frequency ids, preventing zombie slug DOs from re-registering themselves.

---

## Station creation flow

```
1. Client opens create modal → useEffect picks a preview freq from
   pickAvailableFreqId(taken). Purely informational, no reservation.
   The effect is gated on !isCreatingStation to avoid the flash where
   stations updates retrigger the pick right before the modal closes.

2. Client clicks Create → POST /parties/main/index/create-station
   { ownerUid, displayName, storefront, preferredFreq }

3. Index reserves a freq atomically:
   - If preferredFreq is still free → use it (preview matches result)
   - Else → pickAvailableFreqId(taken)
   - 409 if band full

4. Index server-to-server fetches /parties/main/<freq>/create to set
   ownership on the station room (StationOwnership object in storage).

5. Index returns { frequency } to client.

6. Client: addOwnedStationId(freq), setOwnedStationIds, register,
   handleSelectStation(freq).
```

**Cancel of create modal** does nothing (no reservation existed). **Delete of a station** removes it from index registry (`remove_station`); freq becomes available again immediately. Station room storage is NOT cleared — re-creating at the same freq later returns 409 from `/create` because old ownership still exists. (Known gap; not currently fixed.)

---

## Ownership & permissions — CRITICAL

Three layers of ownership truth:

| Layer | Where | What |
|---|---|---|
| Index meta | `stations[].ownerUid` in index storage | Authoritative — set at `/create-station` time |
| Station room | `storage.get("ownership")` (StationOwnership) | Set by `/create` server-to-server call from index |
| Client | `localStorage.ampr_owned_stations` | Cache for UI gating |

Server-side privilege check: `isPrivilegedConn(sender)` = `isOwnerConn` OR `isDJConn`.
- `isOwnerConn`: `connListeners[sender.id].userId === cachedOwnerUid`
- `cachedOwnerUid` is loaded lazily from storage via `getOwnerUid()`

Client-side: `isPrivileged = isOwnStation || djUserIds.includes(user.uid)`, where `isOwnStation = ownedStationIds.includes(currentStationId) || stations.find(s => s.id === currentStationId)?.ownerUid === user.uid`.

### Self-heal pattern

If a station's local `ownership` storage is missing but the index records `meta.ownerUid` for that station, the station heals itself on `join`:

`healOwnershipFromIndex(userId)` fetches `GET /parties/main/index/owner?freq=<id>` and persists ownership locally **iff** `indexOwnerUid === msg.userId`. Never let a random first-joiner claim an unowned station.

This was added because of the `/create` server-to-server fetch silently failing (see next section).

### Hibernation

`connListeners: Map<connId, ConnectedListener>` is **in-memory only**. On DO hibernation, the map is lost but WebSocket connections survive — so the client never reconnects, never re-sends `join`, and the listener stays unregistered until something else repopulates it. To keep this from silently breaking handlers, **every client→server message carries `userId`/`displayName`** (attached in `StationSocket.send`), and handlers re-register the sender from that identity on demand:

- Privileged ops (`reorder_queue`, `enqueue_suggestion`, `skip_track`, `remove_track`, …) gate on `ensurePrivileged(msg, sender)`; `grant_dj`/`revoke_dj` on `ensureOwner(msg, sender)`. Both call `rehydrateFromMessage` first, which re-registers the listener (DJ status from `getDJs()`) and warms `cachedOwnerUid` via `getOwnerUid()` (note: `isOwnerConn` reads the raw cached field, which is null after hibernation until reloaded).
- `handleSuggestTrack` / `handlePostMessage` have their own equivalent fallback.

Historically the privileged gates read only the cold in-memory state, so after the room idled, move-to-top and request-enqueue silently no-op'd until a reconnect or "take ownership" repopulated state (the original bug). If you add a new privileged path, gate it through `ensurePrivileged`/`ensureOwner`, never a bare `isOwnerConn`/`isDJConn`.

---

## PartyKit stub `.fetch()` — CRITICAL regression risk

`this.room.context.parties.main.get(id).fetch(path, init)` requires `path` to be a **path starting with `/`**, NOT a full URL. Passing `http://host/parties/main/<id>/create` throws `Error: Path must start with /`. The error is `console.error`'d but otherwise silent, which is how the original ownership bug stayed hidden for a long time.

✅ Correct: `.fetch("/parties/main/94.5/create", ...)`
❌ Wrong: `.fetch("https://hat.fm/parties/main/94.5/create", ...)`

If you add a new server-to-server fetch, use the path-only form.

The receiving side's `req.url` will have a PartyKit-internal hostname, not the public deployment URL — so don't derive `indexUrl` (or any public URL) from `req.url.host` in the request handler. Use `getIndexUrl()` (env var / storage fallback) or capture from `conn.uri` on a WebSocket connect.

---

## Zombie-station guard

`POST /parties/main/index` with `station_status` for an unknown station id used to auto-revive a stub entry. This caused zombies on every delete:

```
delete → registry entry removed → client disconnects from station →
station.onClose fires notifyIndex(0) → index sees unknown station →
auto-revive as stub with no ownerUid → un-deletable zombie
```

Fix: auto-revive only fires when `msg.liveUntil > 0` (the station claims to be live). Offline pings from unknown stations are dropped silently. If you need to recover a genuinely live station whose index entry was lost, the existing live-ping path still works.

`StationList.canRemove = isOwn || !station.ownerUid` — trash icon shows on any unowned station so leftover zombies can still be cleaned up.

---

## How sync works

```
Server stores: { expirationTime, durationMs } per QueueItem

Client (PlaybackLoop.handleQueueUpdate):
  startTime    = expirationTime - durationMs
  offsetSeconds = max(0, (Date.now() - startTime) / 1000)

Hard switch (track[0] changed):
  1. If now >= expirationTime → skip immediately (catch-up after background)
  2. Set expirationTimer +3 s grace (lets MusicKit auto-advance fire first)
  3. If MusicKit already moved to this track natively → just syncQueueTail
  4. Otherwise playAtOffset(track, offset, tail)

Soft update (same track[0], tail changed):
  → syncQueueTail only — never disrupts current playback

Native auto-advance:
  MusicKit fires nowPlayingItemDidChange
  → PlaybackLoop checks if new ID === queue[1].appleId
  → Yes → expireTrack(key, addToPool=true) to server
  → Server broadcasts new queue
```

### Alarm chaining (server-side expiry)

`onAlarm` in `party/index.ts`:
1. Read `roomId` from storage (room.id is inaccessible in alarm context)
2. Fetch queue; if `Date.now() >= queue[0].expirationTime` → expire it
3. **If alarm fired early** (Cloudflare can fire ~10 s early): re-arm with `room.storage.setAlarm(queue[0].expirationTime)`
4. This "belt-and-suspenders" prevents track stalls when no listeners are watching

---

## Apple Music ID rules — CRITICAL

**Catalog IDs** (what MusicKit needs for `setQueue`) are numeric strings like `"1234567890"`.
**Library IDs** (from `/v1/me/library/...`) look like `"i.AbCdEf..."` — **MusicKit cannot play these**.

| Source | Correct ID field |
|---|---|
| Catalog search / albums / playlists | `item.id` → use `normalizeTrack()` |
| Library playlists | `relationships.catalog.data[0]` (preferred) → falls back to `item.attributes.playParams.catalogId` |
| Library tracks with no catalog equivalent | No playable ID — returned without `appleId`, shown as unavailable in UI |

**`getLibraryPlaylistTracks` fetches with `?include=catalog`** to get the storefront-specific catalog relationship. Using `playParams.catalogId` alone can return an ID from a different storefront.

**`NOT_FOUND` errors**: `AppleMusicPlayer.playAtOffset` catches MusicKit `NOT_FOUND` and wraps it as `UnavailableError`. `PlaybackLoop` catches `UnavailableError` and calls `expireTrack(key, addToPool=false)` to skip without stalling. Tracks with no Apple ID are blocked from `handleAddTrack` in `App.tsx`.

---

## Pool & deduplication

Pool tracks are deduplicated with `sameTrack()` from `shared/track.ts`:
```typescript
function sameTrack(a, b):
  if both have ISRC (non-empty): match on ISRC
  else if both have appleId: match on Apple ID
  else: no match
```
**Never match on empty ISRC** — that was a bug that collapsed the pool to 1 track.

Track identity is `{ isrc, appleId? }` — Apple Music only, no other services.
`migrateTrack` (also `shared/track.ts`) normalizes the three historical stored
shapes (`catalogId` / `platformIds.apple` / `appleId`) on every read; records
matching no shape pass through unstripped. Never delete pool entries for
missing IDs — quarantine (exclude from robot candidates) and let them heal.

Pool is capped at 100 entries (LRU).

## Robot DJ — vibe-aware selection

The robot DJ (`fillRobotQueue` in `party/index.ts`) no longer picks randomly. It
ranks pool candidates by how well they fit the **current vibe** using
`shared/fingerprint.ts` — the ONE implementation imported by both server and
client (same discipline as `shared/track.ts`; tested by `shared/fingerprint.test.ts`).

- A track's **fingerprint** is a fixed-length `number[]` of L2-normalized,
  weighted blocks concatenated: `[ W_TEXT·conf·TEXT_BLOCK ‖ W_CAT·CAT_BLOCK ]`.
  Cosine of two fingerprints = the weight-blended sum of each block's similarity.
- **CAT_BLOCK** (categorical) is built from `Track.fpMeta` — `genreNames`, `year`,
  `hasLyrics`, `explicit` — captured client-side in `normalizeTrack` from default
  Apple Songs attributes (no `extend` needed) and carried through pool-insert.
- **TEXT_BLOCK** is a 384-dim sentence embedding computed **in-browser** via
  transformers.js (`Xenova/all-MiniLM-L6-v2`, int8) — no server/API/Cloudflare
  account. `client/src/services/embed.ts` is **dynamically imported** (lazy
  chunk; passive listeners never download it) and warmed when an add surface
  opens. `handleAddTrack` embeds the track's vibe text and attaches
  `textEmbedding` + `textConfidence`, which ride on the `Track` (like `fpMeta`)
  through to pool-insert. Currently embeds **name text** (title/artist/album/
  genres); album editorial prose is a planned richer upgrade. Embed failure ⇒
  no `textEmbedding` ⇒ `composeFingerprint` degrades to categorical-only.
- **Pick**: `vibeTarget` = recency-weighted centroid of the now-playing track +
  human-queued tracks (robot picks are **excluded as anchors** to prevent an
  echo chamber). `selectVibeAware` (MMR, `ROBOT_MMR_LAMBDA`) ranks candidates,
  balancing on-vibe fit against variety. Empty queue / no anchor ⇒ shuffle fallback.

---

## Identity (no Firebase)

`services/identity.ts` stores everything in localStorage:

| Key | Value |
|---|---|
| `ampr_uid` | UUID — user's permanent ID |
| `ampr_display_name` | DJ display name |
| `ampr_owned_stations` | JSON array of frequency strings (e.g. `["94.5","103.7"]`) |
| `ampr_station_names` | JSON object `{ freq: displayName }` |

Station names decouple from DJ names — a station keeps its name even if the DJ renames themselves. Legacy slug ids in localStorage are swept out on boot (`isValidFreqId` filter).

---

## URL routing

Path-based (no `#`). `window.history.pushState` on station select; `popstate` listener syncs back. Deep links to `/{freq}` work on reload via the apex-domain 404.html SPA shim (`pathSegmentsToKeep = 0`). All path parsing is gated on `isValidFreqId(...)`.

---

## Visual primitives & fonts

`client/src/index.css` defines hand-rolled CSS for:

- **`.btn-3d`** — depressable hardware-button shell with bottom shadow; amber backlight via `text-shadow` (text) and `filter: drop-shadow()` (SVG icons).
- **`.btn-3d-pressed`** — locks the depressed state (e.g. active tabs).
- **`.btn-3d-quiet`** — opts content out of the resting amber glow.
- **`.btn-3d-accent`** — red CTA variant with deeper red underside.
- **`.btn-3d:disabled`** — flat, depressed, no glow.
- **`@keyframes attention-pulse`** — drop-shadow pulse for SVG icons (e.g. empty-queue Plus, muted speaker). No scale.
- **`@keyframes sound-bar`** — clip-path animation for the SoundBars indicator.

**Fonts**:
- Body: system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`).
- Frequency labels: **Press Start 2P** via `.font-press-start` raw CSS class. Do NOT use Tailwind's `font-display` utility — Vite/HMR sometimes misses `tailwind.config.js` edits, leading to silent fallbacks.
- SevenSegDisplay (LED freq) is SVG segments — not font-dependent.

---

## Key components

| Component | Notes |
|---|---|
| `NowPlaying` | Current track, progress, skip, mute, station name (owner inline-edits), prev/next nav, freq LED display |
| `UpNext` | Queue with drag-to-reorder (DJs only; uses `!!onReorder` as privilege gate, not uid) |
| `StationList` | Flat list sorted by frequency. Trash icon visible when `isOwn` OR `!station.ownerUid` (orphan cleanup) |
| `StationModal` | "All stations" / station info — owner can rename, frequency shown read-only |
| `AddTracks` | Catalog search → add to queue |
| `Discovery` | Charts, recommendations, related playlists. Defaults to "heavy" tab when queue is empty |
| `PlaylistModal` | Album/playlist track picker; shows unavailable tracks grayed-out |
| `TrackRow` | Shared track row; accepts `unavailable` prop for grayed-out state |
| `FaceGenerator` | Deterministic procedural avatar from UID seed |
| `PoolModal` | Browse/manage station pool |
| `ChatModal` | In-station chat |
| `ArtworkFlip` | Mobile album-art flip with DJ notes on the back |
| `SoundBars` | Three-state `{playing, muted}`: animated gradient / animated gray / static gray |

---

## Gotchas & decisions

- **`autoplayEnabled`** survives `stop()` — once the user has tapped play, don't block again on station switch.
- **iOS volume**: `MusicKit.volume` is ignored by iOS Safari. Fallback: set `<audio>.muted` instead.
- **`reassertMute()` after playAtOffset**: `playTrackAtOffset` internally calls `unmuteAudio()`. Without re-asserting, mute is lost on every track change.
- **`syncQueueTail`** is non-destructive: only removes stale items after current position, then appends new ones. Never calls `setQueue` unless track[0] actually changed.
- **`playSequence` guard**: incremented on every `playAtOffset` call; stale async completions bail out early.
- **Station reappearing after delete**: `handleRemoveStation` calls both `indexSocket.removeStation()` AND `removeOwnedStationId()` from identity.ts. The auto-revive guard (above) is what prevents the post-disconnect race from re-creating it.
- **Album art sizing**: Apple Music artwork URLs use `{w}x{h}` templates. Always fetch at 2× CSS size for retina. `artworkUrl(template, cssPixels)` in `musickit.ts` fills the template at `cssPixels * 2`.
- **`robotDJPending` flag**: prevents multiple concurrent robot DJ triggers if multiple queue_updates arrive while robot is picking.
- **`shimmer-text` works only on text glyphs** — `background-clip: text` fails on SVG. Use `attention-pulse` on icons.
- **Stale partykit dev bundle**: if a code change isn't reflected in server behavior (e.g. a method appears undefined), `pkill -f partykit && rm -rf .partykit && npm run dev`.

---

## Dev commands

```bash
npm run install:all     # one-time: install root + client deps
npm run dev             # partykit dev (port 1999) + vite (port 5173) concurrently
npm run generate-token  # regenerate VITE_APPLE_DEVELOPER_TOKEN (expires every 180 days)
npm test                # vitest over shared/ (track shape migration tests)
```

Env vars live in `.env` at project root (Vite reads from there via `envDir` in `vite.config.ts`).
`VITE_PARTYKIT_HOST` must match the deployed PartyKit hostname in production.

---

## Deployment

**Automatic** — GitHub Actions (`.github/workflows/deploy.yml`) on every push to `main`:
- **Server**: `npx partykit deploy` → PartyKit's **managed platform** (`*.partykit.dev`, login `theloombot`). PartyKit runs on Cloudflare DO under the hood, but there is **no Cloudflare account of ours** — no account id, API token, or platform bindings (`env.AI`, KV, Vectorize, …). Anything needing those must use an external REST API over `fetch`, or run client-side.
- **Client**: `client/dist/` → **GitHub Pages** (`actions/deploy-pages@v4`). The apex domain `hat.fm` is served via the `CNAME` file + the `404.html` SPA redirect shim (a GitHub Pages convention), with `vite.config.ts` `base: '/'`.

Never run `npm run deploy` manually.
