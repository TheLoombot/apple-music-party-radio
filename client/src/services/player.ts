import type { Platform, QueueItem } from "../types"

export class UnavailableError extends Error {
  constructor(public platform: Platform, public track: QueueItem) {
    super(`"${track.name}" is not available on ${platform}`)
    this.name = "UnavailableError"
  }
}

export interface MusicPlayer {
  /** Load and play a track at the given time offset, optionally preloading the tail queue.
   *  isCancelled() is polled between async steps — return true to bail out before play() runs
   *  (prevents stale playAtOffset calls from audibly starting after a station switch). */
  playAtOffset(track: QueueItem, offsetSeconds: number, tail?: QueueItem[], isCancelled?: () => boolean): Promise<void>
  /** Sync the native queue tail (positions 1+) to match the given tracks.
   *  isCancelled() lets a newer sync supersede an in-flight one. */
  syncQueueTail(tailTracks: QueueItem[], isCancelled?: () => boolean): Promise<void>
  /** Return the Apple ID of the track currently at the native player's queue position, or null */
  getLiveCurrentId(): string | null
  stop(): void
  fadeOut(ms?: number): Promise<void>
  setVolume(level: number): void  // 0 = muted, 1 = full
  isPlaying(): boolean
}
