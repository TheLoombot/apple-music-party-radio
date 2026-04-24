import { useEffect } from "react"
import { motion } from "framer-motion"
import { X } from "lucide-react"
import { Discovery } from "./Discovery"
import type { MusicCatalog } from "../services/catalog"
import type { Track, QueueItem } from "../types"

interface Props {
  onClose: () => void
  catalog: MusicCatalog
  queuedIsrcs: Set<string>
  queue: QueueItem[]
  onAddTrack: (track: Track) => void
}

export function DiscoveryModal({ onClose, catalog, queuedIsrcs, queue, onAddTrack }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="w-full sm:max-w-lg bg-panel rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col h-[80vh]"
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-muted font-medium uppercase tracking-wider">Add or Request</span>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0">
            <X size={18} />
          </button>
        </div>
        <Discovery catalog={catalog} queuedIsrcs={queuedIsrcs} queue={queue} onAddTrack={onAddTrack} embedded />
      </motion.div>
    </motion.div>
  )
}
