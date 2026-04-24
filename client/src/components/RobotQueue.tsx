import { useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import type { QueueItem } from "../types"

interface Props {
  queue: QueueItem[]
  onRemove?: (item: QueueItem) => void
  onAlbumClick?: (item: QueueItem) => void
}

export function RobotQueue({ queue, onRemove, onAlbumClick }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (queue.length === 0) return null

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider flex justify-between items-center hover:bg-surface/30 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span>Robot Queue</span>
          <span className="text-muted/50 normal-case tracking-normal font-normal">auto-filled from pool</span>
        </span>
        <span className="flex items-center gap-3">
          <AnimatePresence mode="wait">
            <motion.span
              key={queue.length}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.15 }}
              className="text-muted tabular-nums font-normal normal-case tracking-normal"
            >
              {queue.length} track{queue.length !== 1 ? "s" : ""}
            </motion.span>
          </AnimatePresence>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            style={{ overflow: "hidden" }}
          >
            <ul>
              {queue.map((item, i) => (
                <li
                  key={item.key}
                  className="group flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0"
                >
                  <span className="text-xs text-muted w-4 text-center flex-shrink-0 tabular-nums">{i + 1}</span>

                  <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
                    {item.artworkUrl ? (
                      <img src={artworkUrl(item.artworkUrl, 192)} alt="" loading="lazy" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-muted/70 text-xs truncate">{item.artistName}</p>
                    <p className="text-white/80 text-base font-semibold truncate">{item.name}</p>
                    {onAlbumClick
                      ? <button onClick={() => onAlbumClick(item)} className="text-muted/50 text-xs truncate hover:text-red-400 transition-colors text-left w-full">{item.albumName}</button>
                      : <p className="text-muted/50 text-xs truncate">{item.albumName}</p>}
                  </div>

                  <span className="text-sm text-muted tabular-nums flex-shrink-0">{formatDuration(item.durationMs)}</span>
                  {onRemove && (
                    <button
                      onClick={() => onRemove(item)}
                      className="w-9 h-9 flex items-center justify-center text-muted hover:text-red-400 transition-colors flex-shrink-0"
                      title="Remove from queue"
                    >
                      <X size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
