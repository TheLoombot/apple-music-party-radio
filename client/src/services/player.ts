import type { QueueItem } from "../types"

export class UnavailableError extends Error {
  constructor(public track: QueueItem) {
    super(`"${track.name}" is not available on Apple Music`)
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
  /** Player's reported state — i.e. MusicKit thinks it's playing. May be true
   *  even when no audio is actually being produced (muted, stalled, autoplay
   *  blocked, etc.). Cheap, synchronous; suitable for control-flow gates. */
  isPlaying(): boolean
  /** Whether the underlying <audio> element is actually producing samples
   *  right now: state==playing AND !paused AND !muted AND volume>0 AND
   *  currentTime advanced within the last ~1s. Use for UI state and stall
   *  detection. */
  isActuallyPlaying(): boolean
  /** Subscribe to transitions in isActuallyPlaying. Callback fires only when
   *  the boolean flips. Returns an unsubscribe function. */
  onActuallyPlayingChange(cb: (playing: boolean) => void): () => void
}
