# Apple Music Party Radio — Claude Code Guide

Real-time collaborative radio stations backed by Apple Music. Listeners hear the same track at the same position via **time-based sync** (each client plays independently, no audio stream through the server). The server is a PartyKit Durable Object; the client is React + MusicKit JS v3.

---

## Architecture

```
party/index.ts          PartyKit Durable Object — all server logic
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
  components/           React UI (see component list below)
```

### Two PartyKit room types

| Room ID | Purpose |
|---|---|
| `"index"` | Global station registry; handles `register`, `remove_station` |
| `"{slug}"` | One station's queue/pool/chat/DJs; handles everything else |

Station rooms POST to the index room to update metadata (`station_status`, `station_presence`).

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
  → PlaybackLoop checks if new ID === queue[1].platformIds.apple
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
| Library tracks with no catalog equivalent | No playable ID — returned with empty `platformIds`, shown as unavailable in UI |

**`getLibraryPlaylistTracks` fetches with `?include=catalog`** to get the storefront-specific catalog relationship. Using `playParams.catalogId` alone can return an ID from a different storefront.

**`NOT_FOUND` errors**: `AppleMusicPlayer.playAtOffset` catches MusicKit `NOT_FOUND` and wraps it as `UnavailableError`. `PlaybackLoop` catches `UnavailableError` and calls `expireTrack(key, addToPool=false)` to skip without stalling. Tracks with no Apple ID are blocked from `handleAddTrack` in `App.tsx`.

---

## Pool & deduplication

Pool tracks are deduplicated with `sameTrack()` in `party/index.ts`:
```typescript
function sameTrack(a, b):
  if both have ISRC (non-empty): match on ISRC
  else if both have platformIds.apple: match on Apple ID
  else if both have platformIds.spotify: match on Spotify ID
  else: no match
```
**Never match on empty ISRC** — that was a bug that collapsed the pool to 1 track.

Pool is capped at 100 entries (LRU). Robot DJ picks randomly from the pool.

---

## Identity (no Firebase)

`services/identity.ts` stores everything in localStorage:

| Key | Value |
|---|---|
| `ampr_uid` | UUID — user's permanent ID |
| `ampr_display_name` | DJ display name |
| `ampr_owned_stations` | JSON array of station slugs this browser created |
| `ampr_station_names` | JSON object `{ slug: displayName }` |

Station names decouple from DJ names — a station keeps its name even if the DJ renames themselves.  
Legacy rooms (created when room ID === owner UID) are auto-migrated on first `join`.

---

## Key components

| Component | Notes |
|---|---|
| `NowPlaying` | Current track, progress, skip, mute, station name (owner can inline-edit) |
| `UpNext` | Queue with drag-to-reorder (DJs only; uses `!!onReorder` as privilege gate, not uid) |
| `StationList` | Live stations shown by default; offline stations behind "All stations" modal |
| `AddTracks` | Catalog search → add to queue |
| `Discovery` | Charts, recommendations, related playlists |
| `PlaylistModal` | Album/playlist track picker; shows unavailable tracks grayed-out |
| `TrackRow` | Shared track row; accepts `unavailable` prop for grayed-out state |
| `FaceGenerator` | Deterministic procedural avatar from UID seed |
| `PoolModal` | Browse/manage station pool |

---

## URL routing

Path-based (no `#`). `window.history.pushState` on station select; `popstate` listener syncs back. Deep links to `/{stationId}` work on reload.

---

## Gotchas & decisions

- **`autoplayEnabled`** survives `stop()` — once the user has tapped play, don't block again on station switch.
- **iOS volume**: `MusicKit.volume` is ignored by iOS Safari. Fallback: set `<audio>.muted` instead.
- **`syncQueueTail`** is non-destructive: only removes stale items after current position, then appends new ones. Never calls `setQueue` unless track[0] actually changed.
- **`playSequence` guard**: incremented on every `playAtOffset` call; stale async completions bail out early.
- **Station reappearing after delete**: `handleRemoveStation` must call both `indexSocket.removeStation()` AND `removeOwnedStationId()` from identity.ts.
- **Album art sizing**: Apple Music artwork URLs use `{w}x{h}` templates. Always fetch at 2× CSS size for retina. `artworkUrl(template, cssPixels)` in `musickit.ts` fills the template at `cssPixels * 2`.
- **`robotDJPending` flag**: prevents multiple concurrent robot DJ triggers if multiple queue_updates arrive while robot is picking.

---

## Dev commands

```bash
npm run install:all     # one-time: install root + client deps
npm run dev             # partykit dev (port 1999) + vite (port 5173) concurrently
npm run generate-token  # regenerate VITE_APPLE_DEVELOPER_TOKEN (expires every 180 days)
npm run deploy          # partykit deploy + vite build
```

Env vars live in `.env` at project root (Vite reads from there via `envDir` in `vite.config.ts`).  
`VITE_PARTYKIT_HOST` must match the deployed PartyKit hostname in production.

---

## Deployment

PartyKit deploys to Cloudflare Workers/DO automatically via `npm run deploy`.  
Client (`client/dist/`) is a static site — deploy to Cloudflare Pages, Vercel, etc.  
Set `VITE_PARTYKIT_HOST` env var on the static host to point to the deployed PartyKit instance.
