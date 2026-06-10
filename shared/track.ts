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

export interface PlatformIds {
  apple?: string
  spotify?: string
}

/** Minimal structural shape for matching — both sides' Track types satisfy it. */
export interface TrackLike {
  isrc?: string
  platformIds?: PlatformIds
}

/**
 * Normalize a stored/received track record to the current canonical shape
 * ({ isrc, platformIds, addedViaPlatform, ... }). Accepts every shape that has
 * ever been written to storage:
 *   1. Original:  { catalogId: "123" }
 *   2. Current:   { platformIds: { apple: "123" } }
 *   3. Flattened: { appleId: "123" }   — written briefly by ef1336d (June 2026)
 *
 * A record matching none of these passes through with `platformIds` defaulted
 * to an empty object — identifying fields it might carry (e.g. isrc) are never
 * stripped, so an unrecognized shape degrades to "temporarily unplayable",
 * never to data loss. Pool records (`lastPlayedAt` present) additionally get
 * addedByUsers/playCount backfilled.
 */
export function migrateTrack<T extends object>(item: T): T {
  const t = item as any
  const apple = t.platformIds?.apple ?? t.appleId ?? t.catalogId
  const { appleId: _a, catalogId: _c, ...rest } = t
  const isPool = "lastPlayedAt" in t
  return {
    ...rest,
    isrc: t.isrc ?? "",
    platformIds: { ...(t.platformIds ?? {}), ...(apple ? { apple } : {}) },
    addedViaPlatform: t.addedViaPlatform ?? "apple",
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
  if (a.platformIds?.apple && b.platformIds?.apple) return a.platformIds.apple === b.platformIds.apple
  if (a.platformIds?.spotify && b.platformIds?.spotify) return a.platformIds.spotify === b.platformIds.spotify
  return false
}
