import { useState, useEffect, useCallback } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Volume2, VolumeX, SkipForward, Library } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import { ArtworkModal } from "./ArtworkModal"
import type { QueueItem, AppUser } from "../types"
import type { MusicCatalog } from "../services/catalog"

interface Props {
  track: QueueItem | null
  stationOwner: string
  currentUser: AppUser
  canSkip: boolean
  onSkip: () => void
  onMuteToggle: () => void
  isMuted: boolean
  isBlocked: boolean
  onResume: () => void
  onAlbumClick?: () => void
  onOpenPool?: () => void
  catalog?: MusicCatalog
}

function useProgress(track: QueueItem | null) {
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!track) { setProgress(0); setElapsed(0); return }

    function tick() {
      const startTime = track!.expirationTime - track!.durationMs
      const elapsedMs = Math.min(Date.now() - startTime, track!.durationMs)
      setElapsed(Math.max(0, elapsedMs))
      setProgress(Math.max(0, Math.min(1, elapsedMs / track!.durationMs)))
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [track?.key])

  return { progress, elapsed }
}

const BAR_DELAYS = ["0s", "0.15s", "0.3s", "0.45s"]
const BAR_DURATIONS = ["0.7s", "0.9s", "0.75s", "0.85s"]

function SoundBars({ active }: { active: boolean }) {
  return (
    <div className="flex items-end gap-0.5 h-6">
      {BAR_DELAYS.map((delay, i) => (
        <div
          key={i}
          className="sound-bar w-1.5"
          style={{
            height: "100%",
            animationDelay: delay,
            animationDuration: BAR_DURATIONS[i],
            background: active
              ? "linear-gradient(to top, #22c55e 0%, #eab308 60%, #fc3c44 100%)"
              : "rgba(255,255,255,0.2)",
          }}
        />
      ))}
    </div>
  )
}

function useMediaSession(
  track: QueueItem | null,
  isPlaying: boolean,
  canSkip: boolean,
  onSkip: () => void,
  onPlay: () => void,
  onPause: () => void,
) {
  useEffect(() => {
    if (!("mediaSession" in navigator)) return

    if (!track) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = "none"
      try { navigator.mediaSession.setPositionState() } catch {}
      navigator.mediaSession.setActionHandler("play", null)
      navigator.mediaSession.setActionHandler("pause", null)
      navigator.mediaSession.setActionHandler("nexttrack", null)
      navigator.mediaSession.setActionHandler("previoustrack", null)
      navigator.mediaSession.setActionHandler("seekto", null)
      navigator.mediaSession.setActionHandler("seekbackward", null)
      navigator.mediaSession.setActionHandler("seekforward", null)
      return
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artistName,
      album: track.albumName,
      artwork: track.artworkUrl
        ? [{ src: artworkUrl(track.artworkUrl, 512), sizes: "512x512", type: "image/jpeg" }]
        : [],
    })

    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused"

    const startTime = track.expirationTime - track.durationMs
    const position = Math.max(0, Math.min(track.durationMs / 1000, (Date.now() - startTime) / 1000))
    try {
      navigator.mediaSession.setPositionState({
        duration: track.durationMs / 1000,
        playbackRate: isPlaying ? 1 : 0,
        position,
      })
    } catch {}

    navigator.mediaSession.setActionHandler("play", onPlay)
    navigator.mediaSession.setActionHandler("pause", onPause)
    navigator.mediaSession.setActionHandler("nexttrack", canSkip ? onSkip : null)
    navigator.mediaSession.setActionHandler("previoustrack", null)
    navigator.mediaSession.setActionHandler("seekto", () => {})
    navigator.mediaSession.setActionHandler("seekbackward", () => {})
    navigator.mediaSession.setActionHandler("seekforward", () => {})
  }, [track?.key, isPlaying, canSkip])
}

export function NowPlaying({ track, stationOwner, currentUser, canSkip, onSkip, isMuted, onMuteToggle, isBlocked, onResume, onAlbumClick, onOpenPool, catalog }: Props) {
  const { progress, elapsed } = useProgress(track)
  const isPlaying = !isMuted && !isBlocked
  const quiet = isMuted || isBlocked
  const [artworkOpen, setArtworkOpen] = useState(false)
  const closeArtwork = useCallback(() => setArtworkOpen(false), [])
  useMediaSession(
    track,
    isPlaying,
    canSkip,
    onSkip,
    isBlocked ? onResume : onMuteToggle,
    isBlocked ? () => {} : onMuteToggle,
  )

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
        Now Playing
      </div>

      <AnimatePresence mode="wait">
        {track ? (
          <motion.div
            key={track.key}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {/* Full-width album art */}
            <motion.div
              key={track.isrc || track.platformIds?.apple}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="w-full aspect-square bg-surface"
            >
              {track.artworkUrl ? (
                <button onClick={() => setArtworkOpen(true)} className="block w-full h-full cursor-zoom-in">
                  <img src={artworkUrl(track.artworkUrl, 400)} alt={track.albumName} className="w-full h-full object-cover" />
                </button>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted text-6xl">♪</div>
              )}
            </motion.div>

            {/* Progress bar + time */}
            <div className="px-4 pt-3">
              <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${progress * 100}%` }}
                  transition={{ duration: 1, ease: "linear" }}
                />
              </div>
              <div className="flex justify-end mt-1.5">
                <span className="text-sm text-muted tabular-nums">−{formatDuration(track.durationMs - elapsed)}</span>
              </div>
            </div>

            {/* Track info */}
            <motion.div
              key={`${track.key}-info`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.05 }}
              className="px-4 pt-1 pb-3"
            >
              <p className="text-muted/70 text-sm">{track.artistName}</p>
              <p className="text-white text-xl font-bold">{track.name}</p>
              {onAlbumClick
                ? <button onClick={onAlbumClick} className="text-muted/50 text-sm mt-0.5 hover:text-red-400 transition-colors text-left">{track.albumName}</button>
                : <p className="text-muted/50 text-sm mt-0.5">{track.albumName}</p>}
              <p className="text-muted text-sm mt-2">
                spun by{" "}
                <span className="text-white/60">
                  {track.addedBy === "robot" ? "🤖"
                    : track.addedBy === currentUser.uid ? "you"
                    : track.addedBy}
                </span>
              </p>
            </motion.div>

            {/* Controls */}
            <div className="flex gap-2 px-4 pb-4">
              <div className="flex-1 flex items-center justify-center py-3 rounded-xl bg-surface">
                <SoundBars active={!quiet} />
              </div>
              <button
                onClick={isBlocked ? onResume : onMuteToggle}
                className="flex-1 py-3 rounded-xl bg-surface font-bold text-base tracking-wide transition-all hover:text-red-400 flex items-center justify-center gap-2"
              >
                {quiet ? (
                  <>
                    <VolumeX size={18} className="shimmer-text" />
                    <span className="shimmer-text">UNMUTE</span>
                  </>
                ) : (
                  <>
                    <Volume2 size={18} />
                    <span>MUTE</span>
                  </>
                )}
              </button>
              {canSkip && (
                <button
                  onClick={onSkip}
                  className="flex-1 py-3 rounded-xl bg-surface font-bold text-base tracking-wide text-white transition-all hover:text-red-400 flex items-center justify-center gap-2"
                >
                  <SkipForward size={18} />
                  <span>SKIP</span>
                </button>
              )}
              {onOpenPool && (
                <button
                  onClick={onOpenPool}
                  className="flex-1 py-3 rounded-xl bg-surface font-bold text-base tracking-wide text-white transition-all hover:text-red-400 flex items-center justify-center gap-2"
                >
                  <Library size={18} />
                  <span>POOL</span>
                </button>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="p-8 text-center text-muted"
          >
            <div className="text-4xl mb-3">📻</div>
            <p className="text-sm">Station is quiet.</p>
            <p className="text-xs mt-1">Add a track to get it started.</p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {artworkOpen && track?.artworkUrl && (
          <ArtworkModal
            src={artworkUrl(track.artworkUrl, 1500)}
            alt={track.albumName}
            onClose={closeArtwork}
            catalog={catalog}
            songId={track.platformIds?.apple}
            albumName={track.albumName}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
