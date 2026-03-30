import { AnimatePresence, motion } from "framer-motion"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import type { QueueItem, AppUser } from "../types"

function formatTotalDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
  return `${m}:${s.toString().padStart(2, "0")}`
}

interface Props {
  queue: QueueItem[]
  currentUser: AppUser
  stationOwner: string
  onRemove: (item: QueueItem) => void
}

export function UpNext({ queue, currentUser, stationOwner, onRemove }: Props) {
  const canRemove = currentUser.uid === stationOwner
  const totalMs = queue.reduce((sum, item) => sum + item.durationMs, 0)

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider flex justify-between items-center">
        <span>Up Next</span>
        <AnimatePresence mode="wait">
          {queue.length > 0 && (
            <motion.span
              key={queue.length}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.15 }}
              className="text-muted tabular-nums font-normal normal-case tracking-normal"
            >
              {queue.length} track{queue.length !== 1 ? "s" : ""}, {formatTotalDuration(totalMs)}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="h-[360px] overflow-y-auto">
      {queue.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">Queue is empty, robot DJ will take over from the station pool</div>
      ) : (
        <ul>
          <AnimatePresence initial={false}>
            {queue.map((item, i) => (
              <motion.li
                key={item.key}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 group"
              >
                <span className="text-xs text-muted w-4 text-center flex-shrink-0 tabular-nums">
                  {i + 1}
                </span>

                <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
                  {item.artworkUrl ? (
                    <img src={artworkUrl(item.artworkUrl, 96)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-muted/70 text-xs truncate">{item.artistName}</p>
                  <p className="text-white text-base font-semibold truncate">{item.name}</p>
                  <p className="text-muted/50 text-xs truncate">{item.albumName}</p>
                  <p className="text-muted text-sm mt-2">
                    queued by{" "}
                    <span className="text-white/60">
                      {item.addedBy === "robot" ? "🤖"
                        : item.addedBy === currentUser.uid ? "you"
                        : item.addedBy}
                    </span>
                  </p>
                </div>

                <span className="text-sm text-muted tabular-nums flex-shrink-0">{formatDuration(item.durationMs)}</span>

                {canRemove && (
                  <button
                    onClick={() => onRemove(item)}
                    className="opacity-0 group-hover:opacity-100 text-muted hover:text-red-400 transition-all text-lg leading-none flex-shrink-0"
                    title="Remove from queue"
                  >
                    ×
                  </button>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      </div>
    </div>
  )
}
