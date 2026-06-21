/**
 * In-browser text embeddings for the vibe-aware Robot DJ's TEXT_BLOCK.
 *
 * Runs a small sentence-transformer (all-MiniLM-L6-v2, int8, 384-dim — exactly
 * shared/fingerprint.ts TEXT_DIMS) locally via transformers.js. No server, no
 * API key, no Cloudflare account: the model is fetched from the HF CDN once,
 * cached in the browser, then inference runs on-device. Embeddings are computed
 * at track-add time and ride on the Track (like fpMeta), so queue anchors and
 * pool candidates alike carry them — independent of pool membership.
 */
import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers"
import type { Track } from "../types"
import { TEXT_DIMS } from "../../../shared/fingerprint"

/** Smallest well-supported transformers.js embedding model at TEXT_DIMS (384). */
const MODEL_ID = "Xenova/all-MiniLM-L6-v2"

/** Confidence for name-only text (title/artist/album/genres). Discounted
 *  because it's thin — used when no editorial prose is available. */
export const NAME_TEXT_CONFIDENCE = 0.6

/** Confidence when real editorial/description prose is folded into the text.
 *  Full weight — this is the rich signal the fingerprint was designed around. */
export const EDITORIAL_TEXT_CONFIDENCE = 1

/** Cap editorial length so long prose can't blow past the model's ~256-token
 *  window and bury the identity-bearing head (title/artist/album/genres),
 *  which we always place first. */
const MAX_EDITORIAL_CHARS = 600

env.allowLocalModels = false  // always fetch from the HF CDN + cache in-browser

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    // `pipeline` is heavily overloaded; cast past the union (TS2590) — the task
    // string pins the runtime type to a feature-extraction pipeline.
    extractorPromise = (pipeline as any)("feature-extraction", MODEL_ID, { dtype: "q8" }) as Promise<FeatureExtractionPipeline>
  }
  return extractorPromise
}

/** Kick off the one-time model download + init in the background so the first
 *  real embed is fast. Safe to call repeatedly. */
export function warmEmbedder(): void {
  void getExtractor().catch(() => { extractorPromise = null })  // allow retry on failure
}

/** Embed text → a TEXT_DIMS-length unit vector. Returns null on any failure so
 *  callers degrade to categorical-only (composeFingerprint handles null). */
export async function embedText(text: string): Promise<number[] | null> {
  const clean = text.trim()
  if (!clean) return null
  try {
    const extractor = await getExtractor()
    const out = await extractor(clean, { pooling: "mean", normalize: true })
    const arr = Array.from(out.data as Float32Array)
    return arr.length === TEXT_DIMS ? arr : null
  } catch {
    extractorPromise = null  // allow a later retry
    return null
  }
}

/** The text we embed for a track. The head (title/artist/album/genres) is
 *  always present and comes first so it survives token truncation; album/
 *  playlist editorial prose, when available, is appended (capped) for a much
 *  richer vibe signal. Pass `editorial` to fold it in — callers raise
 *  textConfidence to EDITORIAL_TEXT_CONFIDENCE when they do. */
export function vibeTextForTrack(t: Track, editorial?: string): string {
  const head = [t.name, t.artistName, t.albumName, ...(t.fpMeta?.genreNames ?? [])]
    .filter(Boolean)
    .join(" — ")
  const ed = editorial?.trim()
  return ed ? `${head} — ${ed.slice(0, MAX_EDITORIAL_CHARS)}` : head
}
