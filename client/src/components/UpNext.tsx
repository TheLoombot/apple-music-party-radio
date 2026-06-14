import { AnimatePresence, motion } from "framer-motion"
import { ChevronsUp, X } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import { DJFace, RobotFace } from "./FaceGenerator"
import { Tooltip } from "./Tooltip"
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
  onReorder?: (keys: string[]) => void
  onAlbumClick?: (item: QueueItem) => void
}

export function UpNext({ queue, currentUser, stationOwner, onRemove, onReorder, onAlbumClick }: Props) {
  // Nothing queued — don't render the panel at all.
  if (queue.length === 0) return null

  const canRemove = !!onReorder
  const canReorder = !!onReorder && queue.length > 1
  const totalMs = queue.reduce((sum, item) => sum + item.durationMs, 0)

  const moveToTop = (index: number) => {
    const keys = queue.map(i => i.key)
    const reordered = [...keys]
    const [removed] = reordered.splice(index, 1)
    reordered.unshift(removed)
    onReorder!(reordered)
  }

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

      <div>
        {queue.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">No tracks queued — search or browse to add or request some</div>
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
                  className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 group transition-colors hover:bg-surface/50"
                >
                  {/* Position number or move-to-top button */}
                  <div className="flex-shrink-0 flex items-center justify-center w-10">
                    {canReorder && i > 0 ? (
                      <Tooltip label="Move to top" align="start">
                        <button
                          onClick={() => moveToTop(i)}
                          aria-label="Move to top of queue"
                          className="btn-3d w-10 h-10 rounded-lg flex items-center justify-center text-muted hover:text-white"
                        >
                          <ChevronsUp size={16} />
                        </button>
                      </Tooltip>
                    ) : (
                      <span className="text-xs text-muted tabular-nums text-center">{i + 1}</span>
                    )}
                  </div>

                  <div className="w-14 h-14 md:w-24 md:h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
                    {item.artworkUrl ? (
                      <img src={artworkUrl(item.artworkUrl, 192)} alt="" loading="lazy" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-muted/70 text-xs truncate">{item.artistName}</p>
                    <p className="text-white text-sm md:text-base font-semibold truncate">{item.name}</p>
                    {onAlbumClick
                      ? <button onClick={() => onAlbumClick(item)} className="text-muted/50 text-xs truncate hover:text-red-400 transition-colors text-left w-full">{item.albumName}</button>
                      : <p className="text-muted/50 text-xs truncate">{item.albumName}</p>}
                    {/* div, not p: DJFace/RobotFace render a <div>, invalid inside <p> */}
                    <div className="text-muted text-xs mt-1 flex items-center gap-1 flex-wrap">
                      <span className="whitespace-nowrap">queued by</span>
                      {item.addedBy === "robot"
                        ? <RobotFace size={16} />
                        : <DJFace uid={item.addedBy} size={16} />
                      }
                      <span className="text-white/60 truncate">
                        {item.addedBy === "robot" ? "robot"
                          : item.addedBy === currentUser.uid ? currentUser.displayName
                          : item.addedByName ?? item.addedBy}
                      </span>
                    </div>
                  </div>

                  {/* Duration + remove: stacked on mobile, inline on desktop */}
                  <div className="flex-shrink-0 flex flex-col md:flex-row items-end md:items-center justify-between md:gap-3 self-stretch py-0.5 md:py-0 md:self-auto">
                    <span className="text-xs md:text-sm text-muted tabular-nums">{formatDuration(item.durationMs)}</span>
                    {canRemove && (
                      <Tooltip label="Remove from queue" align="end">
                        <button
                          onClick={() => onRemove(item)}
                          aria-label="Remove from queue"
                          className="btn-3d w-12 h-12 rounded-lg flex items-center justify-center text-muted hover:text-red-400"
                        >
                          <X size={18} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  )
}
