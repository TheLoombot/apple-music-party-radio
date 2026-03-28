/**
 * Synchronized playback loop — driven by PartyKit queue state.
 *
 * Listens for queue updates from the station socket and drives a MusicPlayer
 * so all listeners hear the same track at the same position.
 */
import { stationSocket } from "./partykit"
import { UnavailableError } from "./player"
import { startAudioSession, resumeAudioSession } from "./audioSession"
import type { MusicPlayer } from "./player"
import type { QueueItem } from "../types"

export class PlaybackLoop {
  private stationId = ""
  private expirationTimer: ReturnType<typeof setTimeout> | null = null
  private currentTrackKey: string | null = null
  private currentTrack: QueueItem | null = null
  private pendingPlay: { track: QueueItem; offsetSeconds: number } | null = null
  private autoplayEnabled = false   // stays true once user has tapped "Tap to listen"
  private robotDJPending = false    // prevent duplicate triggerRobotDJ for the same empty-queue event

  onNowPlayingChange?: (item: QueueItem | null) => void
  onQueueChange?: (upNext: QueueItem[]) => void
  onPlaybackBlocked?: () => void

  constructor(private player: MusicPlayer) {}

  start(stationId: string) {
    this.stop()
    this.stationId = stationId

    stationSocket.onQueueUpdate = this.handleQueueUpdate
    stationSocket.connect(stationId)
    document.addEventListener("visibilitychange", this.handleVisibilityChange)
  }

  stop() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange)
    stationSocket.onQueueUpdate = undefined
    stationSocket.disconnect()
    if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
    this.currentTrackKey = null
    this.currentTrack = null
    this.pendingPlay = null
    this.robotDJPending = false
    // intentionally keep autoplayEnabled — once the user has tapped, don't ask again
  }

  async resume() {
    this.autoplayEnabled = true
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
    this.player.setVolume(muted ? 0 : 1)
  }

  private handleVisibilityChange = () => {
    if (document.hidden) return
    resumeAudioSession()
    if (!this.currentTrack) return
    if (Date.now() >= this.currentTrack.expirationTime) {
      stationSocket.expireTrack(this.currentTrack.key, true)
    }
  }

  private handleQueueUpdate = async (queue: QueueItem[]) => {
    this.onQueueChange?.(queue.slice(1))

    if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }

    if (queue.length === 0) {
      this.onNowPlayingChange?.(null)
      this.currentTrackKey = null
      this.currentTrack = null
      this.pendingPlay = null
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

    // Track has passed its expiration — tell the server to expire it
    if (now >= track0.expirationTime) {
      stationSocket.expireTrack(track0.key, /* addToPool */ true)
      return
    }

    // Schedule expiration check
    const delay = track0.expirationTime - now + 500
    this.expirationTimer = setTimeout(() => {
      stationSocket.expireTrack(track0.key, true)
    }, delay)

    this.onNowPlayingChange?.(track0)

    if (track0.key === this.currentTrackKey) return  // already playing

    this.currentTrackKey = track0.key
    this.currentTrack = track0
    const startTime = track0.expirationTime - track0.durationMs
    const offsetSeconds = Math.max(0, (now - startTime) / 1000)

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
        // Expiration timer will still fire and advance the queue for this listener
      } else {
        console.error("[PlaybackLoop] playback error:", err)
      }
    }
  }
}
