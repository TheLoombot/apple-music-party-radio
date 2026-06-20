/**
 * Track "fingerprint" — the vibe-aware recommendation core. Like shared/track.ts
 * this is the ONE implementation imported by BOTH the PartyKit server
 * (party/index.ts, which composes + stores fingerprints at pool-insert and
 * ranks candidates at robot-pick time) and the client. Never fork it.
 * Covered by shared/fingerprint.test.ts (`npm test` at the repo root).
 *
 * A fingerprint is a flat number[] made of fixed-size, L2-normalized, weighted
 * BLOCKS concatenated end to end:
 *
 *   [ W_TEXT·conf · TEXT_BLOCK  ‖  W_CAT · CAT_BLOCK ]
 *
 * Cosine similarity of two such vectors equals the weight-blended sum of each
 * block's own cosine similarity — so "fit score" is literally
 *   W_TEXT·conf·(mood similarity) + W_CAT·(genre/era similarity).
 * New signals (behavioral, acoustic) are added LATER as more appended blocks;
 * the picker never changes.
 *
 * Pure + dependency-free on purpose: no network, no model, no infra. The text
 * embedding itself is produced elsewhere (Cloudflare Workers AI at pool-insert)
 * and handed in as TEXT_BLOCK; everything here is arithmetic.
 */

// ─── Dimensions & weights (tune these; storage layout depends on the dims) ───

/** Length of the text-embedding block. Matches Cloudflare `@cf/baai/bge-small-en-v1.5`. */
export const TEXT_DIMS = 384
/** Genre slots — genres are hashed into this many buckets (no fixed vocab to maintain). */
export const GENRE_DIMS = 64
/** Categorical block = genre buckets + [yearNorm, instrumentalFlag, explicitFlag]. */
export const CAT_DIMS = GENRE_DIMS + 3
/** Total stored fingerprint length. */
export const FINGERPRINT_DIMS = TEXT_DIMS + CAT_DIMS

/** Block weights. Text carries the richer "vibe"; categorical is the reliable backbone. */
export const W_TEXT = 0.6
export const W_CAT = 0.4

/** Year normalization window — maps a release year into ~[0,1]. */
const YEAR_MIN = 1950
const YEAR_MAX = 2035

/** The metadata a fingerprint is built from (everything Apple gives us cheaply). */
export interface FingerprintMeta {
  genreNames?: string[]
  /** Release year (parse from releaseDate or the `℗ YYYY` in copyright). */
  year?: number
  /** Apple `hasLyrics` — false/absent ⇒ treat as instrumental. */
  hasLyrics?: boolean
  /** Apple `contentRating === "explicit"`. */
  explicit?: boolean
}

// ─── Vector helpers ──────────────────────────────────────────────────────────

/** L2-normalize to unit length. A zero vector stays zero (no NaN). */
export function l2normalize(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm === 0) return v.slice()
  return v.map(x => x / norm)
}

/** Cosine similarity. Inputs need not be normalized; zero vectors ⇒ 0. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function scale(v: number[], k: number): number[] {
  return v.map(x => x * k)
}

/** FNV-1a 32-bit hash — stable across client/server, used for genre bucketing. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ─── Block construction ────────────────────────────────────────────────────

/**
 * Build the (un-normalized) categorical block from metadata. Genres are
 * lower-cased and hashed into GENRE_DIMS buckets (multi-hot). The hashing trick
 * avoids shipping/maintaining Apple's ~200-entry genre vocabulary and degrades
 * gracefully for genres we've never seen.
 */
export function buildCategorical(meta: FingerprintMeta): number[] {
  const v = new Array<number>(CAT_DIMS).fill(0)
  for (const g of meta.genreNames ?? []) {
    if (!g) continue
    v[hash32(g.toLowerCase()) % GENRE_DIMS] = 1
  }
  const year = meta.year
  if (typeof year === "number" && Number.isFinite(year)) {
    const t = (year - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)
    v[GENRE_DIMS] = Math.max(0, Math.min(1, t))
  }
  v[GENRE_DIMS + 1] = meta.hasLyrics ? 0 : 1   // instrumental flag
  v[GENRE_DIMS + 2] = meta.explicit ? 1 : 0
  return v
}

/**
 * Compose the stored fingerprint. `textBlock` is the raw embedding from Workers
 * AI (length TEXT_DIMS) or null when the embed call failed / no text was
 * available — in that case the text block is zeroed and contributes nothing to
 * similarity, so ranking falls back to categorical only (graceful degradation;
 * never blocks a pool-insert). `textConfidence` ∈ [0,1] downweights the text
 * block when it came from the name-only fallback rather than real editorial.
 */
export function composeFingerprint(
  textBlock: number[] | null,
  meta: FingerprintMeta,
  textConfidence = 1,
): number[] {
  const catN = scale(l2normalize(buildCategorical(meta)), W_CAT)

  let textPart: number[]
  if (textBlock && textBlock.length === TEXT_DIMS) {
    const conf = Math.max(0, Math.min(1, textConfidence))
    textPart = scale(l2normalize(textBlock), W_TEXT * conf)
  } else {
    textPart = new Array<number>(TEXT_DIMS).fill(0)
  }
  return textPart.concat(catN)
}

// ─── Vibe target + ranking ───────────────────────────────────────────────────

/**
 * Recency-weighted centroid of the tracks defining "the current vibe" (the
 * now-playing item plus recent history, most-recent FIRST). `decay` ∈ (0,1] is
 * the geometric falloff per step back — smaller = the vibe moves faster.
 * Returns a vector in fingerprint space to rank candidates against.
 */
export function vibeTarget(fingerprints: number[][], decay = 0.7): number[] {
  const acc = new Array<number>(FINGERPRINT_DIMS).fill(0)
  let w = 1
  let total = 0
  for (const fp of fingerprints) {
    for (let i = 0; i < acc.length && i < fp.length; i++) acc[i] += fp[i] * w
    total += w
    w *= decay
  }
  if (total === 0) return acc
  return acc.map(x => x / total)
}

export interface Candidate {
  /** Stable identity (isrc/appleId) — opaque to this module. */
  id: string
  fingerprint: number[]
}

/**
 * Select up to `count` candidates that fit the vibe target while staying
 * diverse, via Maximal Marginal Relevance. Each pick maximizes
 *   λ·similarity(candidate, target) − (1−λ)·maxSimilarity(candidate, alreadyPicked)
 * λ=1 is pure "closest to the vibe" (risks near-duplicates); lower λ injects
 * variety. Returns candidates in pick order. Does not mutate inputs.
 */
export function selectVibeAware(
  target: number[],
  candidates: Candidate[],
  count: number,
  lambda = 0.7,
): Candidate[] {
  const remaining = candidates.slice()
  const picked: Candidate[] = []
  while (picked.length < count && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const rel = cosine(remaining[i].fingerprint, target)
      let maxSim = 0
      for (const p of picked) {
        const s = cosine(remaining[i].fingerprint, p.fingerprint)
        if (s > maxSim) maxSim = s
      }
      const score = lambda * rel - (1 - lambda) * maxSim
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }
    picked.push(remaining.splice(bestIdx, 1)[0])
  }
  return picked
}
