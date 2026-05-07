import { AnimatePresence, motion } from "framer-motion"
import { GripVertical, X } from "lucide-react"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
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

interface SortableItemProps {
  item: QueueItem
  index: number
  canReorder: boolean
  canRemove: boolean
  currentUser: AppUser
  onRemove: (item: QueueItem) => void
  onAlbumClick?: (item: QueueItem) => void
}

function SortableItem({ item, index, canReorder, canRemove, currentUser, onRemove, onAlbumClick }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key })

  return (
    <motion.li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: isDragging ? 0.3 : 1, y: 0 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className={[
        "flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 group transition-colors",
        isDragging ? "relative z-10 shadow-lg bg-surface/80" : "hover:bg-surface/50",
      ].join(" ")}
    >
      {canReorder ? (
        <GripVertical
          size={14}
          {...attributes}
          {...listeners}
          className="text-muted/40 group-hover:text-muted/70 flex-shrink-0 cursor-grab active:cursor-grabbing touch-none"
        />
      ) : (
        <span className="text-xs text-muted w-4 text-center flex-shrink-0 tabular-nums">{index + 1}</span>
      )}

      <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
        {item.artworkUrl ? (
          <img src={artworkUrl(item.artworkUrl, 192)} alt="" loading="lazy" className="w-full h-full object-cover" />
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
          className="w-9 h-9 flex items-center justify-center text-muted hover:text-red-400 transition-colors flex-shrink-0"
          title="Remove from queue"
        >
          <X size={15} />
        </button>
      )}
    </motion.li>
  )
}

export function UpNext({ queue, currentUser, stationOwner, onRemove, onReorder, onAlbumClick }: Props) {
  const canRemove = !!onReorder
  const canReorder = !!onReorder && queue.length > 1
  const totalMs = queue.reduce((sum, item) => sum + item.durationMs, 0)

  const sensors = useSensors(
    useSensor(PointerSensor),
    // 250 ms hold on the grip handle initiates drag on touch devices,
    // giving scroll a chance to claim the gesture first.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const keys = queue.map(i => i.key)
    onReorder!(arrayMove(keys, keys.indexOf(active.id as string), keys.indexOf(over.id as string)))
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
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={queue.map(i => i.key)} strategy={verticalListSortingStrategy}>
              <ul>
                <AnimatePresence initial={false}>
                  {queue.map((item, i) => (
                    <SortableItem
                      key={item.key}
                      item={item}
                      index={i}
                      canReorder={canReorder}
                      canRemove={canRemove}
                      currentUser={currentUser}
                      onRemove={onRemove}
                      onAlbumClick={onAlbumClick}
                    />
                  ))}
                </AnimatePresence>
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  )
}
