import { useEffect } from "react"
import { motion } from "framer-motion"
import { X } from "lucide-react"
import { ArtworkFlip } from "./ArtworkFlip"
import type { MusicCatalog } from "../services/catalog"

interface Props {
  src: string
  alt: string
  onClose: () => void
  catalog?: MusicCatalog
  // Pass exactly one of these to enable the flip
  albumId?: string    // Apple Music album catalog ID
  playlistId?: string // Apple Music playlist catalog ID
  songId?: string     // resolves to album automatically
  // Shown on the back as fallback when there are no editorial notes
  albumName?: string
  releaseYear?: number
  djNotes?: Record<string, string>
  onSaveDjNote?: (itemId: string, note: string) => void
}

export function ArtworkModal({ src, alt, onClose, catalog, albumId, playlistId, songId, albumName, releaseYear, djNotes, onSaveDjNote }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 cursor-pointer"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={e => { e.stopPropagation(); onClose() }}
    >
      <motion.div
        className="relative cursor-default"
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={e => e.stopPropagation()}
      >
        <ArtworkFlip
          src={src}
          alt={alt}
          catalog={catalog}
          albumId={albumId}
          playlistId={playlistId}
          songId={songId}
          albumName={albumName}
          releaseYear={releaseYear}
          outerStyle={{ width: "min(90vw, 90vh)", height: "min(90vw, 90vh)" }}
          cardClassName="rounded-xl shadow-2xl"
          djNotes={djNotes}
          onSaveDjNote={onSaveDjNote}
        />

        {/* Close button — top-right */}
        <button
          onClick={onClose}
          className="absolute -top-4 -right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors cursor-pointer"
          title="Close"
        >
          <X size={18} />
        </button>
      </motion.div>
    </motion.div>
  )
}
