import type { Platform, QueueItem } from "../types"

export class UnavailableError extends Error {
  constructor(public platform: Platform, public track: QueueItem) {
    super(`"${track.name}" is not available on ${platform}`)
    this.name = "UnavailableError"
  }
}

export interface MusicPlayer {
  /** Load and play a track at the given time offset */
  playAtOffset(track: QueueItem, offsetSeconds: number): Promise<void>
  stop(): void
  setVolume(level: number): void  // 0 = muted, 1 = full
}
