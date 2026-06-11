/**
 * Shared track-shape utilities — the ONE implementation used by both the
 * PartyKit server (party/index.ts) and the client (client/src/services/*).
 *
 * History: these used to be hand-mirrored copies on each side. The mirrors
 * drifted — a June 2026 shape-flatten refactor (ef1336d) fixed the migration
 * on the client but not the server, and the broken server migration combined
 * with a destructive pool sanitizer permanently wiped station pools. Do not
 * fork this logic again; import it. Covered by shared/track.test.ts
 * (`npm test` at the repo root).
 */

/** Minimal structural shape for matching — both sides' Track types satisfy it. */
export interface TrackLike {
  isrc?: string
  appleId?: string
}

/**
 * Normalize a stored/received track record to the current canonical shape
 * ({ isrc, appleId?, ... }). Accepts every shape that has ever been written
 * to storage:
 *   1. Original: { catalogId: "123" }
 *   2. Mid:      { platformIds: { apple: "123" } }  (spotify slot always empty — dropped)
 *   3. Current:  { appleId: "123" }
 *
 * A record matching none of these passes through flattened but unstripped —
 * identifying fields it might carry (e.g. isrc) are never lost, so an
 * unrecognized shape degrades to "temporarily unplayable", never to data
 * loss. Pool records (`lastPlayedAt` present) additionally get
 * addedByUsers/playCount backfilled.
 */
export function migrateTrack<T extends object>(item: T): T {
  const t = item as any
  const appleId = t.appleId ?? t.platformIds?.apple ?? t.catalogId
  const { appleId: _f, platformIds: _p, catalogId: _c, addedViaPlatform: _a, ...rest } = t
  const isPool = "lastPlayedAt" in t
  return {
    ...rest,
    isrc: t.isrc ?? "",
    ...(appleId ? { appleId } : {}),
    ...(isPool ? { addedByUsers: t.addedByUsers ?? [], playCount: t.playCount ?? 1 } : {}),
  } as T
}

/**
 * Match two tracks for deduplication (pool upserts, queue duplicate checks,
 * suggestion matching). ISRC wins when both records have one. Never match on
 * empty ISRC — that bug once collapsed an entire pool into a single track.
 */
export function sameTrack(a: TrackLike, b: TrackLike): boolean {
  if (a.isrc && b.isrc) return a.isrc === b.isrc
  if (a.appleId && b.appleId) return a.appleId === b.appleId
  return false
}

/**
 * Stable string key for track-keyed persistence (e.g. the heart-accumulation
 * maps). ISRC preferred — it survives catalog-ID churn and storefront
 * differences. Null when the track has no identity at all.
 */
export function trackKey(t: TrackLike): string | null {
  if (t.isrc) return `isrc:${t.isrc}`
  if (t.appleId) return `apple:${t.appleId}`
  return null
}
