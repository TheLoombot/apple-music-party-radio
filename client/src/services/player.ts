import type { Platform, QueueItem } from "../types"

export class UnavailableError extends Error {
  constructor(public platform: Platform, public track: QueueItem) {
    super(`"${track.name}" is not available on ${platform}`)
    this.name = "UnavailableError"
  }
}

export interface MusicPlayer {
  /** Load and play a track at the given time offset, optionally preloading the tail queue */
  playAtOffset(track: QueueItem, offsetSeconds: number, tail?: QueueItem[]): Promise<void>
  /** Sync the native queue tail (positions 1+) to match the given tracks */
  syncQueueTail(tailTracks: QueueItem[]): Promise<void>
  /** Return the Apple ID of the track currently at the native player's queue position, or null */
  getLiveCurrentId(): string | null
  stop(): void
  setVolume(level: number): void  // 0 = muted, 1 = full
  isPlaying(): boolean
}
