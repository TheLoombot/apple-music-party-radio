import { playTrackAtOffset, syncQueueTail, getMusicKit } from "./musickit"
import { UnavailableError } from "./player"
import type { MusicPlayer } from "./player"
import type { QueueItem } from "../types"

const isNotFound = (err: any) => err?.errorCode === "NOT_FOUND" || String(err).includes("NOT_FOUND")

export class AppleMusicPlayer implements MusicPlayer {
  // ── Actual-playback monitor ────────────────────────────────────────────────
  // MusicKit's playbackState reports its intended state (we called play(),
  // didn't pause). The underlying <audio> element can still be silent — muted,
  // paused at the OS level, stalled on buffering, blocked by autoplay policy.
  // We poll the audio element's currentTime to detect actual sample production.
  // Polling (vs event listeners) handles two things cleanly: (1) MusicKit
  // creates the <audio> element lazily on first play, so we'd miss it if we
  // only attached once on construction; (2) some browsers throttle timeupdate
  // under certain conditions, but currentTime always reflects truth.
  private monitoredAudio: HTMLAudioElement | null = null
  private lastCurrentTime = -1
  private lastAdvancedAt = 0
  private cachedActuallyPlaying = false
  private listeners = new Set<(playing: boolean) => void>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // 250ms gives ≤250ms latency on UI state transitions; CPU cost is trivial.
    this.pollTimer = setInterval(() => this.tick(), 250)
  }

  private tick(): void {
    const audio = document.querySelector("audio") as HTMLAudioElement | null
    if (audio !== this.monitoredAudio) {
      this.monitoredAudio = audio
      this.lastCurrentTime = -1
    }
    if (audio && !audio.paused && audio.currentTime !== this.lastCurrentTime) {
      this.lastAdvancedAt = Date.now()
      this.lastCurrentTime = audio.currentTime
    }
    this.recompute()
  }

  private computeActuallyPlaying(): boolean {
    try {
      const music = getMusicKit() as any
      if (music.playbackState !== 2) return false
      const audio = this.monitoredAudio
      if (!audio) return false
      if (audio.paused || audio.muted || audio.volume === 0) return false
      // currentTime must have advanced within ~2 poll intervals to count as
      // actively playing; longer means stalled/paused/interrupted.
      return (Date.now() - this.lastAdvancedAt) < 600
    } catch { return false }
  }

  private recompute(): void {
    const next = this.computeActuallyPlaying()
    if (next === this.cachedActuallyPlaying) return
    this.cachedActuallyPlaying = next
    this.listeners.forEach(cb => { try { cb(next) } catch { /* ignore */ } })
  }

  isActuallyPlaying(): boolean {
    return this.cachedActuallyPlaying
  }

  onActuallyPlayingChange(cb: (playing: boolean) => void): () => void {
    this.listeners.add(cb)
    // Fire with current state so the subscriber doesn't sit at the default
    // (false) until the next transition.
    try { cb(this.cachedActuallyPlaying) } catch { /* ignore */ }
    return () => { this.listeners.delete(cb) }
  }

  async playAtOffset(track: QueueItem, offsetSeconds: number, tail?: QueueItem[], isCancelled?: () => boolean): Promise<void> {
    const appleId = track.appleId
    if (!appleId) throw new UnavailableError(track)
    if (isCancelled?.()) return
    const tailIds = tail?.map(t => t.appleId).filter((id): id is string => !!id)
    try {
      await playTrackAtOffset(appleId, offsetSeconds, tailIds, isCancelled)
    } catch (err: any) {
      if (!isNotFound(err)) throw err
      // NOT_FOUND on a multi-track setQueue can mean a tail track is bad, not the main track.
      // Retry with no tail — if it succeeds the main track is fine and syncQueueTail
      // will clean up the tail on the next queue update.
      if (tailIds && tailIds.length > 0) {
        if (isCancelled?.()) return
        try {
          await playTrackAtOffset(appleId, offsetSeconds, [], isCancelled)
          return
        } catch (retryErr: any) {
          if (!isNotFound(retryErr)) throw retryErr
        }
      }
      throw new UnavailableError(track)
    }
  }

  async syncQueueTail(tailTracks: QueueItem[], isCancelled?: () => boolean): Promise<void> {
    if (isCancelled?.()) return
    const tailIds = tailTracks.map(t => t.appleId).filter((id): id is string => !!id)
    try {
      await syncQueueTail(tailIds, isCancelled)
    } catch (err: any) {
      // A tail track's catalog ID isn't resolvable in this storefront — non-fatal.
      // Current playback is unaffected; the track will be skipped via expireTrack
      // when it becomes now-playing.
      if (!isNotFound(err)) throw err
    }
  }

  stop() {
    try { getMusicKit().stop() } catch { /* not ready */ }
  }

  async fadeOut(ms = 200): Promise<void> {
    const steps = 8
    const interval = ms / steps
    for (let i = steps - 1; i >= 0; i--) {
      this.setVolume(i / steps)
      await new Promise(r => setTimeout(r, interval))
    }
  }

  getLiveCurrentId(): string | null {
    try {
      const music = getMusicKit()
      // nowPlayingItem is set once MusicKit commits to the new track
      if (music.nowPlayingItem?.id) return String(music.nowPlayingItem.id)
      // queue.items[position] is set as soon as position advances (before nowPlayingItem)
      const q = music.queue
      if (q.position >= 0 && q.items[q.position]?.id) return String(q.items[q.position].id)
      return null
    } catch { return null }
  }

  isPlaying(): boolean {
    try {
      const music = getMusicKit() as any
      return music.playbackState === 2  // MusicKit.PlaybackStates.playing
    } catch { return false }
  }

  setVolume(level: number) {
    try { (getMusicKit() as any).volume = level } catch { /* not ready */ }
    // iOS Safari ignores programmatic volume changes; toggle muted as fallback
    try {
      const audio = document.querySelector("audio")
      if (audio) audio.muted = (level === 0)
    } catch { /* not ready */ }
  }
}
