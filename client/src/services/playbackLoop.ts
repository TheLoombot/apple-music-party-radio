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
 * On visibility restore (tab re-focused), playback is re-synced to the correct
 * offset in the current track, recovering from any blocked play() calls that
 * occurred while the tab was in the background.
 */
import { stationSocket } from "./partykit"
import { UnavailableError } from "./player"
import { startAudioSession, resumeAudioSession } from "./audioSession"
import type { MusicPlayer } from "./player"
import type { QueueItem } from "../types"

export class PlaybackLoop {
  private currentTrack: QueueItem | null = null
  private currentTrackKey: string | null = null
  private pendingPlay: { track: QueueItem; offsetSeconds: number } | null = null
  private autoplayEnabled = false   // stays true once user has tapped "Tap to listen"
  private robotDJPending = false    // prevent duplicate triggerRobotDJ for the same empty-queue event
  private muted = false
  private expirationTimer: ReturnType<typeof setTimeout> | null = null

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
  }

  stop() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange)
    stationSocket.onQueueUpdate = undefined
    stationSocket.disconnect()
    this.currentTrack = null
    this.currentTrackKey = null
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
    try {
      await this.player.playAtOffset(track, offsetSeconds)
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] track unavailable on resume:", track.name)
      } else {
        console.error("[PlaybackLoop] resume error:", err)
      }
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

  private handleVisibilityChange = async () => {
    if (document.hidden) return
    resumeAudioSession()

    // Re-sync playback position when returning to the tab.
    // While backgrounded, play() calls may have been blocked by Safari; the track may
    // have advanced (or not started at all). Seek to wherever we should be right now.
    if (!this.autoplayEnabled || !this.currentTrack) return
    if (this.player.isPlaying()) return  // still going — no need to rehydrate
    const track = this.currentTrack
    const now = Date.now()
    if (now >= track.expirationTime) return  // already expired — wait for next queue_update
    const startTime = track.expirationTime - track.durationMs
    const offsetSeconds = Math.max(0, (now - startTime) / 1000)
    try {
      await this.player.playAtOffset(track, offsetSeconds)
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] track unavailable on tab focus:", track.name)
      } else {
        console.error("[PlaybackLoop] tab focus restore error:", err)
      }
    }
  }

  private handleQueueUpdate = async (queue: QueueItem[]) => {
    this.onQueueChange?.(queue.slice(1))

    if (queue.length === 0) {
      this.onNowPlayingChange?.(null)
      this.currentTrack = null
      this.currentTrackKey = null
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

    if (track0.key === this.currentTrackKey) return  // already playing

    this.currentTrack = track0
    this.currentTrackKey = track0.key
    const startTime = track0.expirationTime - track0.durationMs
    const offsetSeconds = Math.max(0, (now - startTime) / 1000)

    // Schedule a fallback expiration on the client — the server DO alarm is authoritative
    // in production, but this ensures advancement works in local dev and in the foreground.
    // The server ignores duplicate expire_track messages for already-advanced keys.
    if (this.expirationTimer) clearTimeout(this.expirationTimer)
    this.expirationTimer = setTimeout(
      () => stationSocket.expireTrack(track0.key, true),
      Math.max(0, track0.expirationTime - Date.now())
    )

    // Never call play() without a prior user gesture — browser/MusicKit will show
    // a dialog and throw an opaque internal error before we can catch NotAllowedError.
    if (!this.autoplayEnabled) {
      this.pendingPlay = { track: track0, offsetSeconds }
      this.onPlaybackBlocked?.()
      return
    }

    try {
      await this.player.playAtOffset(track0, offsetSeconds)
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] track unavailable:", track0.name)
      } else {
        console.error("[PlaybackLoop] playback error:", err)
      }
    }
  }
}
