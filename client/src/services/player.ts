import type { Platform, QueueItem } from "../types"

export class UnavailableError extends Error {
  constructor(public platform: Platform, public track: QueueItem) {
    super(`"${track.name}" is not available on ${platform}`)
    this.name = "UnavailableError"
  }
}

export interface MusicPlayer {
  /** Load the full queue into the native player and start playing from offsetSeconds */
  playAtOffset(track: QueueItem, offsetSeconds: number, upNext: QueueItem[]): Promise<void>
  /** Update the tracks queued after the currently-playing item without restarting it */
  syncQueue(currentTrack: QueueItem, upNext: QueueItem[]): Promise<void>
  stop(): void
  setVolume(level: number): void  // 0 = muted, 1 = full
}
