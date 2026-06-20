# Vibe-aware Robot DJ — project doc (in progress)

Status: **Phase 1 shipped on branch `vibe-aware-robot-dj`** (categorical-only fingerprint).
Text-embedding and behavioral signals are designed but not yet wired.

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
| **TEXT** (editorial/mood) | Album `editorialNotes` (+ name fallback) → text embedding | Designed, not wired |
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

**Recommended: Option C.** It keeps the no-new-accounts property, and the client
already fetches the album editorial text. The storage shape already assumes
`TEXT_DIMS = 384` (bge-small), so A/B/C are interchangeable later.

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

1. **Verify live** — run the app, confirm the robot tracks a mellow vs. hype
   queue and the shuffle fallback still fires on an empty queue.
2. **Option C** — client-side `bge-small` text embedding → fill `TEXT_BLOCK`.
   Requires the album editorial fetch on add (the `__dumpAppleMeta` probe in
   `appleMusic.ts` is the throwaway scaffold for this — **remove before final
   merge**).
3. **BEHAV block** — mine our own station co-occurrence + skip signals.
4. Decide whether to **precompute + store** fingerprints at pool-insert once
   TEXT/BEHAV make on-the-fly recompute non-trivial.

---

## Files

| File | Role |
|---|---|
| `shared/fingerprint.ts` | Pure core: blocks, compose, `vibeTarget`, `selectVibeAware` |
| `shared/fingerprint.test.ts` | Invariants (13 tests) |
| `client/src/types.ts` | `Track.fpMeta?` |
| `client/src/services/appleMusic.ts` | `normalizeTrack` captures `fpMeta`; `__dumpAppleMeta` probe (throwaway) |
| `party/index.ts` | `fillRobotQueue` vibe-aware pick; `ROBOT_MMR_LAMBDA` |
| `CLAUDE.md` | Corrected deployment section; Robot DJ section |
