/**
 * Pure utility functions shared between the PartyKit server and tests.
 * Extracted from party/index.ts so they can be imported and tested independently.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type Platform = "apple" | "spotify"

export interface PlatformIds {
  apple?: string
  spotify?: string
}

export interface Track {
  isrc: string
  platformIds: PlatformIds
  addedViaPlatform: Platform
  name: string
  artistName: string
  albumName: string
  artworkUrl: string
  durationMs: number
}

export interface QueueItem extends Track {
  key: string
  expirationTime: number
  addedBy: string
  addedByName?: string
  addedAt: number
}

export interface PoolTrack extends Track {
  lastPlayedAt: number
  addedByUsers: string[]
  playCount: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Grace period added to queue[0].expirationTime when reporting liveUntil.
 *  Covers worst-case Cloudflare alarm latency (~30 s) plus notification round-trip
 *  so the station never incorrectly blinks offline mid-song. */
export const LIVE_UNTIL_GRACE_MS = 60_000

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Match two tracks for pool deduplication.
 * NEVER match on empty ISRC — that would collapse all ISRC-less tracks into one pool entry.
 */
export function sameTrack(a: Pick<Track, "isrc" | "platformIds">, b: Pick<Track, "isrc" | "platformIds">): boolean {
  if (a.isrc && b.isrc) return a.isrc === b.isrc
  if (a.platformIds?.apple && b.platformIds?.apple) return a.platformIds.apple === b.platformIds.apple
  if (a.platformIds?.spotify && b.platformIds?.spotify) return a.platformIds.spotify === b.platformIds.spotify
  return false
}

/**
 * Compute the liveUntil timestamp for a station given its current queue.
 * Uses queue[0].expirationTime (not the last track) + a grace buffer.
 */
export function liveUntilFromQueue(queue: Pick<QueueItem, "expirationTime">[]): number {
  if (queue.length === 0) return 0
  return Math.max(queue[0].expirationTime, Date.now()) + LIVE_UNTIL_GRACE_MS
}

/**
 * Migrate old catalogId-based track shapes to the current platformIds shape.
 * Also backfills fields added to PoolTrack after initial release.
 * Runs transparently on every queue/pool read until all stored data is updated.
 */
export function migrateTrack(item: any): any {
  if (item.platformIds) {
    // Backfill fields for pool tracks that predate addedByUsers / playCount
    if ('lastPlayedAt' in item) {
      return {
        ...item,
        addedByUsers: item.addedByUsers ?? [],
        playCount: item.playCount ?? 1,
      }
    }
    return item
  }
  const { catalogId, isrc, ...rest } = item
  return {
    ...rest,
    isrc: isrc ?? "",
    platformIds: { apple: catalogId },
    addedViaPlatform: "apple",
  }
}

/** Returns true when a track has at least one playable platform ID. */
export function hasAnyPlatformId(t: { platformIds: PlatformIds }): boolean {
  return !!(t.platformIds?.apple || t.platformIds?.spotify)
}
