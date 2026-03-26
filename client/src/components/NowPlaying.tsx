import { useState, useEffect } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import type { QueueItem, AppUser } from "../types"

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
}

function useProgress(track: QueueItem | null) {
  const [progress, setProgress] = useState(0)   // 0–1
  const [elapsed, setElapsed] = useState(0)      // ms

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

export function NowPlaying({ track, stationOwner, currentUser, canSkip, onSkip, isMuted, onMuteToggle, isBlocked, onResume }: Props) {
  const { progress, elapsed } = useProgress(track)

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
            <div className="p-4 flex gap-4 items-start">
              {/* Album art */}
              <motion.div
                key={track.catalogId}
                initial={{ scale: 0.92, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className="flex-shrink-0 w-28 h-28 rounded-lg overflow-hidden bg-surface"
              >
                {track.artworkUrl ? (
                  <img src={artworkUrl(track.artworkUrl, 112)} alt={track.albumName} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted text-3xl">♪</div>
                )}
              </motion.div>

              {/* Track info */}
              <motion.div
                key={`${track.key}-info`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: 0.05 }}
                className="flex-1 min-w-0"
              >
                <p className="text-white font-semibold truncate">{track.name}</p>
                <p className="text-muted text-sm truncate">{track.artistName}</p>
                <p className="text-muted text-xs truncate mt-0.5">{track.albumName}</p>

                <p className="text-muted text-xs mt-3">
                  via{" "}
                  <span className="text-white/60">
                    {track.addedBy === "robot" ? "🤖"
                      : track.addedBy === currentUser.uid ? "you"
                      : track.addedBy}
                  </span>
                </p>

                <div className="flex items-center gap-2 mt-3">
                  {isBlocked ? (
                    <button
                      onClick={onResume}
                      className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white text-xs font-medium px-3 py-1.5 rounded-full transition-colors"
                    >
                      ▶ Tap to listen
                    </button>
                  ) : (
                    <button onClick={onMuteToggle} className="text-muted hover:text-white transition-colors text-sm" title={isMuted ? "Unmute" : "Mute"}>
                      {isMuted ? "🔇" : "🔊"}
                    </button>
                  )}
                  {canSkip && (
                    <button onClick={onSkip} className="ml-auto text-muted hover:text-accent transition-colors" title="Skip track">
                      ⏭
                    </button>
                  )}
                </div>
              </motion.div>
            </div>

            {/* Progress bar + time */}
            <div className="px-4 pb-4">
              <div className="w-full h-1 bg-surface rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${progress * 100}%` }}
                  transition={{ duration: 1, ease: "linear" }}
                />
              </div>
              <div className="flex justify-end mt-1.5">
                <span className="text-xs text-muted tabular-nums">−{formatDuration(track.durationMs - elapsed)}</span>
              </div>
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
    </div>
  )
}
