import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import { X } from "lucide-react"
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
}

export function ArtworkModal({ src, alt, onClose, catalog, albumId, playlistId, songId, albumName, releaseYear }: Props) {
  const [flipped, setFlipped] = useState(false)
  const [bgColor, setBgColor] = useState("#111111")
  const [textColor, setTextColor] = useState("#ffffff")
  // undefined = not yet fetched, null = fetched but empty
  const [notes, setNotes] = useState<string | null | undefined>(undefined)
  const [fetchedAlbumName, setFetchedAlbumName] = useState<string | undefined>(undefined)
  const [fetchedReleaseYear, setFetchedReleaseYear] = useState<number | undefined>(undefined)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  useEffect(() => {
    if (!catalog) return

    let active = true

    async function load() {
      let info
      if (albumId) {
        info = await catalog!.getAlbumEditorial(albumId)
      } else if (playlistId) {
        info = await catalog!.getPlaylistEditorial(playlistId)
      } else if (songId) {
        const album = await catalog!.getAlbumForTrack(songId)
        if (!active || !album) return
        if (active) { setFetchedAlbumName(album.name); setFetchedReleaseYear(album.releaseYear) }
        info = await catalog!.getAlbumEditorial(album.id)
      } else {
        return
      }
      if (!active) return
      if (info.bgColor) setBgColor(`#${info.bgColor}`)
      if (info.textColor1) setTextColor(`#${info.textColor1}`)
      setNotes(info.notes ?? null)
    }

    load()
    return () => { active = false }
  }, [albumId, playlistId, songId, catalog])

  const canFlip = !!catalog && !!(albumId || playlistId || songId)
  const displayAlbumName = fetchedAlbumName ?? albumName
  const displayReleaseYear = fetchedReleaseYear ?? releaseYear
  const header = [displayAlbumName, displayReleaseYear].filter(Boolean).join("  ·  ")

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
        {/* Plain div for perspective so Framer Motion's transform doesn't interfere */}
        <div style={{ perspective: "1200px" }}>
          {/* Card — rotates on flip */}
          <div
            onClick={canFlip ? () => setFlipped(f => !f) : undefined}
            style={{
              width: "min(90vw, 90vh)",
              height: "min(90vw, 90vh)",
              position: "relative",
              transformStyle: "preserve-3d",
              transition: "transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)",
              transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
              cursor: canFlip ? "pointer" : "default",
            }}
          >
            {/* Front: artwork */}
            <img
              src={src}
              alt={alt}
              className="absolute inset-0 w-full h-full object-cover rounded-xl shadow-2xl"
              style={{ backfaceVisibility: "hidden" }}
            />

            {/* Back: editorial notes / description */}
            <div
              className="absolute inset-0 rounded-xl shadow-2xl overflow-y-auto"
              style={{
                backfaceVisibility: "hidden",
                transform: "rotateY(180deg)",
                backgroundColor: bgColor,
              }}
              onClick={e => { e.stopPropagation(); setFlipped(false) }}
            >
              <div className="p-7" style={{ color: textColor }}>
                {header && (
                  <p className="text-base font-bold uppercase tracking-widest opacity-70 mb-4">{header}</p>
                )}
                {notes && (
                  <p className="text-2xl font-semibold leading-snug whitespace-pre-line">{notes}</p>
                )}
              </div>
            </div>
          </div>
        </div>

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
