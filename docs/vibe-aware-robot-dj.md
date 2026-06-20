# Vibe-aware Robot DJ — project doc (in progress)

Status: **Phases 1–2 shipped on branch `vibe-aware-robot-dj`.**
- Phase 1: categorical fingerprint + vibe-aware picker.
- Phase 2: in-browser TEXT embedding (name text) via transformers.js.
Behavioral/acoustic signals and album-editorial text are designed, not yet wired.

---

## Goal

Make the Robot DJ pick tracks that **fit the current vibe** of a station's queue
instead of picking uniformly at random from the pool. Optimize for "playlist
vibe" — smooth, intentional-feeling transitions and an evolving mood — rather
than raw acoustic similarity.

Before this work, the entire intelligence of the robot was one line in
`fillRobotQueue` (`party/index.ts`):

```ts
const pick = candidates[Math.floor(Math.random() * candidates.length)]
```

A pool spanning lo-fi, death metal, and disco would whiplash between them.

---

## Approach: fingerprints + a chooser

Two separate concerns, deliberately decoupled:

1. **The fingerprint** (per track) — a list of numbers ("coordinates in music
   space"). Computed once per track; songs that feel alike sit close together.
2. **The chooser** — recency-weighted **centroid** of the current vibe → cosine
   similarity → **MMR** (variety vs. fit). Pure arithmetic, no infra.

A fingerprint is fixed-length blocks, each L2-normalized and weighted, then
concatenated:

```
[ W_TEXT·conf · TEXT_BLOCK  ‖  W_CAT · CAT_BLOCK  ‖  (future blocks…) ]
```

Key property: cosine of two such vectors **equals the weight-blended sum of each
block's own cosine**. So the final "fit score" is literally:

```
W_TEXT·conf·(mood similarity) + W_CAT·(genre/era similarity)
```

New signals are added later as **more appended blocks** — the chooser never
changes. This is the whole point of composing by concatenation.

All of this lives in `shared/fingerprint.ts`, the ONE implementation imported by
both server and client (same discipline as `shared/track.ts`), tested by
`shared/fingerprint.test.ts` (`npm test`).

---

## The four fingerprint blocks

| Block | Source | Status |
|---|---|---|
| **CAT** (categorical) | Apple `genreNames`, release year, `hasLyrics`, `contentRating` | **Done** |
| **TEXT** (mood) | Name text (title/artist/album/genres) → in-browser embedding | **Done (name text)**; album editorial = upgrade |
| **BEHAV** (collaborative) | Co-occurrence in our own stations, `addedByUsers`, hearts, **skip penalties** | Future |
| **AUDIO** (acoustic) | 30s preview embedding (CLAP/MERT) or AcousticBrainz by ISRC | Future |

### CAT — what shipped
- Genres hashed into `GENRE_DIMS` buckets (multi-hot) — no fixed Apple genre
  vocabulary to maintain; unknown genres degrade gracefully.
- Year normalized into ~[0,1]; instrumental + explicit flags.
- Captured client-side in `normalizeTrack` (`appleMusic.ts`) from **default**
  Apple Songs attributes — **no `extend`, no extra fetch** — and carried on
  `Track.fpMeta` through pool-insert via the existing spread plumbing.

### TEXT — the next step (see "Open decisions")
- We confirmed (via the `__dumpAppleMeta` probe) that album `editorialNotes`
  (`short` / `standard` / `tagline`) is rich and populated for catalogued
  albums; **artist** `editorialNotes` is unreliable (often absent) — dropped.
- Coverage is **partial** (popular/curated releases only) → must fall back to
  embedding `artist + album + track + genres` text, with a lower
  `textConfidence` so thin metadata doesn't pollute the vibe.
- `editorialNotes` is **per-album**, so all tracks on an album share TEXT; the
  CAT / future BEHAV+AUDIO blocks differentiate within an album.

---

## The chooser (shipped)

In `fillRobotQueue`:
- **Vibe target** = `vibeTarget(...)`: recency-weighted centroid of the
  now-playing track + any **human-queued** tracks. Robot picks are **excluded
  as anchors** so the station can't drift into an echo chamber of its own
  choices.
- **Selection** = `selectVibeAware(...)`: MMR over pool candidates, balancing
  closeness to the vibe against not-a-near-duplicate-of-what-was-just-picked.
  Tuned by `ROBOT_MMR_LAMBDA` (1 = pure fit, lower = more variety).
- **Cold start** (empty queue / no anchor): Fisher–Yates shuffle fallback —
  unchanged from old behavior.

Fingerprints are computed **on the fly** at pick time (cheap arithmetic over
~100 candidates). No fingerprint is stored yet; `fpMeta` is. When TEXT/BEHAV
arrive we may precompute + store the full vector at pool-insert for efficiency.

---

## Hard constraint discovered: no Cloudflare account

- **Server** deploys via `npx partykit deploy` to PartyKit's **managed
  platform** (`*.partykit.dev`, login `theloombot`). PartyKit runs on Cloudflare
  DO under the hood, but **we have no Cloudflare account** — no account id, API
  token, or platform bindings (`env.AI`, KV, Vectorize).
- **Client** deploys to **GitHub Pages** (not Cloudflare Pages — `CLAUDE.md` was
  corrected on this branch).

Consequence: the original "Cloudflare Workers AI for embeddings" plan is out.
Options for TEXT embeddings without a CF account:

| Option | New account? | Infra |
|---|---|---|
| **C. Client-side embed** (transformers.js `bge-small`, 384-dim, send vector to server) | **None** | ~25MB model, lazy-loaded + cached |
| B. Other embedding API (OpenAI/Voyage/Jina) | maybe | per-call key |
| A. Standalone Cloudflare acct (Workers AI REST, no hosting migration) | yes (free tier) | one token |

**Chose Option C (shipped).** `client/src/services/embed.ts` runs
`Xenova/all-MiniLM-L6-v2` (int8, 384-dim = `TEXT_DIMS`) via transformers.js.
- **Where**: `handleAddTrack` embeds the track's vibe text and attaches
  `textEmbedding` + `textConfidence` before sending; it rides on the `Track`
  through pool-insert (so anchors + pool candidates carry it — pool membership
  irrelevant, which was the key design question).
- **Lazy**: dynamically `import()`-ed so transformers.js (~229KB gzip JS + 21MB
  ORT WASM + ~23MB model on first use) is **not** in the main bundle; passive
  listeners download none of it. Warmed when the Discovery add-surface opens.
- **Failure** ⇒ track sent without embedding ⇒ categorical-only (graceful).

### Known costs / follow-ups for Phase 2
- The 21MB ORT WASM is emitted into `dist/` (served from GitHub Pages, fetched
  on demand). Could offload to a CDN via `env.backends.onnx.wasm.wasmPaths` to
  shrink the deploy artifact.
- `textEmbedding` (384 floats) now travels on every queue/pool item over the
  WebSocket and is broadcast to all clients, who don't need it for rendering.
  Stripping embeddings from server→client broadcasts (or int8-quantizing) would
  cut bandwidth — notable for the ~100-entry pool.
- Tracks added via non-`handleAddTrack` paths (CSV import, library, suggestions)
  lack embeddings ⇒ categorical-only. Acceptable; backfill later if needed.

---

## Tuning knobs

- `W_TEXT` / `W_CAT` (`shared/fingerprint.ts`) — block weights (default 0.6/0.4).
- `ROBOT_MMR_LAMBDA` (`party/index.ts`) — fit vs. variety.
- `vibeTarget` `decay` — how fast the vibe can move (recency falloff).
- `textConfidence` — downweight name-only fallback text vs. real editorial.

---

## Evaluation (not yet built)

- **Offline**: Spotify Million Playlist Dataset continuation task (hide a
  playlist's tail, measure recall@k / NDCG) once we have real embeddings.
- **Online**: skip rate on robot picks (we already have `skip_track`), and
  enqueue-acceptance. Skip-after-track-X is also the BEHAV block's training
  signal — uniquely ours.

---

## What's left

1. **Verify live** — run the app, confirm (a) the robot tracks a mellow vs. hype
   queue, (b) the shuffle fallback fires on an empty queue, (c) the embed chunk
   + model actually load in-browser on add and embeddings reach the server.
2. **Album editorial text** — upgrade `vibeTextForTrack` to fetch + embed album
   `editorialNotes` (richer than name text, higher `textConfidence`). The
   `__dumpAppleMeta` probe in `appleMusic.ts` is the throwaway scaffold —
   **remove before final merge**. Needs the async-fetch handled without
   blocking bulk adds (optimistic add + embedding patch message).
3. **Bandwidth/deploy trims** — strip embeddings from server→client broadcasts;
   offload ORT WASM to a CDN (see "Known costs" above).
4. **BEHAV block** — mine our own station co-occurrence + skip signals.
5. Decide whether to **precompute + store** fingerprints at pool-insert once
   TEXT/BEHAV make on-the-fly recompute non-trivial.

---

## Files

| File | Role |
|---|---|
| `shared/fingerprint.ts` | Pure core: blocks, compose, `vibeTarget`, `selectVibeAware` |
| `shared/fingerprint.test.ts` | Invariants (13 tests) |
| `client/src/services/embed.ts` | In-browser transformers.js embedding (`embedText`, `vibeTextForTrack`, `warmEmbedder`) |
| `client/src/types.ts` | `Track.fpMeta?`, `Track.textEmbedding?`, `Track.textConfidence?` |
| `client/src/services/appleMusic.ts` | `normalizeTrack` captures `fpMeta`; `__dumpAppleMeta` probe (throwaway) |
| `client/src/App.tsx` | `handleAddTrack` embeds on add (dynamic import); warms on Discovery open |
| `client/vite.config.ts` | `optimizeDeps.exclude` for transformers.js |
| `party/index.ts` | `fillRobotQueue` vibe-aware pick (TEXT+CAT); `ROBOT_MMR_LAMBDA` |
| `CLAUDE.md` | Corrected deployment section; Robot DJ section |
