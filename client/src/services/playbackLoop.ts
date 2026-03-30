/**
 * Synchronized playback loop — driven by PartyKit queue state.
 *
 * Listens for queue updates from the station socket and drives a MusicPlayer
 * so all listeners hear the same track at the same position.
 *
 * The server is authoritative on queue advancement — its Durable Object alarm
 * fires at each track's expirationTime and broadcasts the updated queue.
 * The client also keeps a fallback expiration timer (belt-and-suspenders for
 * local dev and foreground reliability).
 *
 * For background playback on desktop: the full server queue is loaded into
 * MusicKit's native queue on every playAtOffset call. When a track ends
 * naturally, the audio engine advances to the next item without needing a new
 * play() call. We detect the native advancement via nowPlayingItemDidChange,
 * immediately notify the server, and update local state so the incoming
 * queue_update is treated as a same-track tail sync rather than a new play.
 */
import { stationSocket } from "./partykit"
import { onNowPlayingItemChange } from "./musickit"
import { UnavailableError } from "./player"
import { startAudioSession, resumeAudioSession } from "./audioSession"
import type { MusicPlayer } from "./player"
import type { QueueItem } from "../types"

export class PlaybackLoop {
  private currentTrack: QueueItem | null = null
  private currentTrackKey: string | null = null
  private currentUpNext: QueueItem[] = []
  private pendingPlay: { track: QueueItem; offsetSeconds: number } | null = null
  private autoplayEnabled = false   // stays true once user has tapped "Tap to listen"
  private robotDJPending = false    // prevent duplicate triggerRobotDJ for the same empty-queue event
  private muted = false
  private expirationTimer: ReturnType<typeof setTimeout> | null = null
  private nativeAdvancing = false   // true while we're driving MusicKit programmatically
  private removeNowPlayingListener: (() => void) | null = null

  onNowPlayingChange?: (item: QueueItem | null) => void
  onQueueChange?: (upNext: QueueItem[]) => void
  onPlaybackBlocked?: () => void
  onMutedChange?: (muted: boolean) => void

  constructor(private player: MusicPlayer) {}

  start(stationId: string) {
    this.stop()
    this.setMuted(false)

    stationSocket.onQueueUpdate = this.handleQueueUpdate
    stationSocket.connect(stationId)
    document.addEventListener("visibilitychange", this.handleVisibilityChange)
    this.removeNowPlayingListener = onNowPlayingItemChange(this.handleNowPlayingItemChange)
  }

  stop() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange)
    this.removeNowPlayingListener?.()
    this.removeNowPlayingListener = null
    stationSocket.onQueueUpdate = undefined
    stationSocket.disconnect()
    this.currentTrack = null
    this.currentTrackKey = null
    this.currentUpNext = []
    this.pendingPlay = null
    this.robotDJPending = false
    if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
    // intentionally keep autoplayEnabled — once the user has tapped, don't ask again
  }

  async resume() {
    this.autoplayEnabled = true
    this.setMuted(false)
    startAudioSession()
    if (!this.pendingPlay) return
    const { track, offsetSeconds } = this.pendingPlay
    this.pendingPlay = null
    this.nativeAdvancing = true
    try {
      await this.player.playAtOffset(track, offsetSeconds, this.currentUpNext)
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] track unavailable on resume:", track.name)
      } else {
        console.error("[PlaybackLoop] resume error:", err)
      }
    } finally {
      this.nativeAdvancing = false
    }
  }

  enableAutoplay() {
    this.autoplayEnabled = true
  }

  setMuted(muted: boolean) {
    this.muted = muted
    this.player.setVolume(muted ? 0 : 1)
    this.onMutedChange?.(muted)
  }

  // Fires when MusicKit's audio engine naturally advances to the next track —
  // i.e. the previous track finished playing, not because we called setQueue/play.
  // We preemptively update local state and notify the server so the queue advances.
  private handleNowPlayingItemChange = () => {
    if (this.nativeAdvancing) return  // we triggered this — ignore
    if (!this.currentTrack) return

    const prevTrack = this.currentTrack

    // Advance internal state immediately so the incoming queue_update from the
    // server is treated as "same track, sync tail" rather than "new track, play".
    const nextTrack = this.currentUpNext[0] ?? null
    this.currentUpNext = this.currentUpNext.slice(1)
    if (nextTrack) {
      this.currentTrack = nextTrack
      this.currentTrackKey = nextTrack.key
      this.onNowPlayingChange?.(nextTrack)
    } else {
      this.currentTrack = null
      this.currentTrackKey = null
    }

    stationSocket.expireTrack(prevTrack.key, true)
  }

  private handleVisibilityChange = async () => {
    if (document.hidden) return
    resumeAudioSession()

    // Re-sync playback when returning to the tab — play() calls may have been
    // blocked by Safari while backgrounded, so the track may not have started.
    if (!this.autoplayEnabled || !this.currentTrack) return
    const track = this.currentTrack
    const now = Date.now()
    if (now >= track.expirationTime) return  // already expired — wait for next queue_update
    const startTime = track.expirationTime - track.durationMs
    const offsetSeconds = Math.max(0, (now - startTime) / 1000)
    this.nativeAdvancing = true
    try {
      await this.player.playAtOffset(track, offsetSeconds, this.currentUpNext)
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] track unavailable on tab focus:", track.name)
      } else {
        console.error("[PlaybackLoop] tab focus restore error:", err)
      }
    } finally {
      this.nativeAdvancing = false
    }
  }

  private handleQueueUpdate = async (queue: QueueItem[]) => {
    const newUpNext = queue.slice(1)
    this.onQueueChange?.(newUpNext)

    if (queue.length === 0) {
      this.onNowPlayingChange?.(null)
      this.currentTrack = null
      this.currentTrackKey = null
      this.currentUpNext = []
      this.pendingPlay = null
      if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
      this.player.stop()
      if (!this.robotDJPending) {
        this.robotDJPending = true
        stationSocket.triggerRobotDJ()
      }
      return
    }

    this.robotDJPending = false

    const track0 = queue[0]
    const now = Date.now()

    this.onNowPlayingChange?.(track0)

    // Always refresh the fallback expiration timer for the current track
    if (this.expirationTimer) clearTimeout(this.expirationTimer)
    this.expirationTimer = setTimeout(
      () => stationSocket.expireTrack(track0.key, true),
      Math.max(0, track0.expirationTime - Date.now())
    )

    if (track0.key === this.currentTrackKey) {
      // Same track still playing — sync the tail if it changed.
      // After a natural MusicKit advancement handleNowPlayingItemChange already
      // sliced currentUpNext, so the keys will match and no sync is needed.
      const tailChanged = newUpNext.map(t => t.key).join(",") !== this.currentUpNext.map(t => t.key).join(",")
      this.currentUpNext = newUpNext
      if (tailChanged) {
        this.nativeAdvancing = true
        try {
          await this.player.syncQueue(track0, newUpNext)
        } catch (err) {
          console.error("[PlaybackLoop] syncQueue error:", err)
        } finally {
          this.nativeAdvancing = false
        }
      }
      return
    }

    // New track — full play
    this.currentTrack = track0
    this.currentTrackKey = track0.key
    this.currentUpNext = newUpNext
    const startTime = track0.expirationTime - track0.durationMs
    const offsetSeconds = Math.max(0, (now - startTime) / 1000)

    // Never call play() without a prior user gesture — browser/MusicKit will show
    // a dialog and throw an opaque internal error before we can catch NotAllowedError.
    if (!this.autoplayEnabled) {
      this.pendingPlay = { track: track0, offsetSeconds }
      this.onPlaybackBlocked?.()
      return
    }

    this.nativeAdvancing = true
    try {
      await this.player.playAtOffset(track0, offsetSeconds, newUpNext)
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] track unavailable:", track0.name)
      } else {
        console.error("[PlaybackLoop] playback error:", err)
      }
    } finally {
      this.nativeAdvancing = false
    }
  }
}
