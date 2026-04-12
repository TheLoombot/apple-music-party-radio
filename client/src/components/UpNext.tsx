import { useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { GripVertical } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import { DJFace, RobotFace } from "./FaceGenerator"
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
  const canRemove = !!onReorder
  const canReorder = !!onReorder && queue.length > 1
  const totalMs = queue.reduce((sum, item) => sum + item.durationMs, 0)

  const [draggedKey, setDraggedKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  const handleDrop = (targetKey: string) => {
    if (!draggedKey || draggedKey === targetKey) return
    const keys = queue.map(i => i.key)
    const from = keys.indexOf(draggedKey)
    const to = keys.indexOf(targetKey)
    const reordered = [...keys]
    reordered.splice(from, 1)
    reordered.splice(to, 0, draggedKey)
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
          <div className="p-6 text-center text-muted text-sm">No tracks queued — search or browse below to add some</div>
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
                  draggable={canReorder}
                  onDragStart={(e) => {
                    setDraggedKey(item.key)
                    ;(e as any).dataTransfer.effectAllowed = "move"
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    ;(e as any).dataTransfer.dropEffect = "move"
                    if (dragOverKey !== item.key) setDragOverKey(item.key)
                  }}
                  onDragLeave={() => setDragOverKey(null)}
                  onDrop={(e) => {
                    e.preventDefault()
                    handleDrop(item.key)
                    setDraggedKey(null)
                    setDragOverKey(null)
                  }}
                  onDragEnd={() => {
                    setDraggedKey(null)
                    setDragOverKey(null)
                  }}
                  className={[
                    "flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 group transition-colors",
                    canReorder ? "cursor-grab active:cursor-grabbing" : "",
                    draggedKey === item.key ? "opacity-30" : "opacity-100",
                    dragOverKey === item.key && draggedKey !== item.key ? "bg-accent/10 border-t-2 border-t-accent" : "hover:bg-surface/50",
                  ].join(" ")}
                >
                  {canReorder ? (
                    <GripVertical
                      size={14}
                      className="text-muted/40 group-hover:text-muted/70 flex-shrink-0 cursor-grab active:cursor-grabbing"
                    />
                  ) : (
                    <span className="text-xs text-muted w-4 text-center flex-shrink-0 tabular-nums">{i + 1}</span>
                  )}

                  <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
                    {item.artworkUrl ? (
                      <img src={artworkUrl(item.artworkUrl, 192)} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-muted/70 text-xs truncate">{item.artistName}</p>
                    <p className="text-white text-base font-semibold">{item.name}</p>
                    {onAlbumClick
                      ? <button onClick={() => onAlbumClick(item)} className="text-muted/50 text-xs truncate hover:text-red-400 transition-colors text-left w-full">{item.albumName}</button>
                      : <p className="text-muted/50 text-xs truncate">{item.albumName}</p>}
                    <p className="text-muted text-xs mt-2 flex items-center gap-1">
                      queued by{" "}
                      {item.addedBy === "robot"
                        ? <RobotFace size={18} />
                        : <DJFace uid={item.addedBy} size={18} />
                      }
                      <span className="text-white/60">
                        {item.addedBy === "robot" ? "robot"
                          : item.addedBy === currentUser.uid ? currentUser.displayName
                          : item.addedByName ?? item.addedBy}
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
