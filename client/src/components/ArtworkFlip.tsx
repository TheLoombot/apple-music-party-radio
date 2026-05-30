import { useEffect, useState } from "react"
import type { CSSProperties } from "react"
import type { MusicCatalog } from "../services/catalog"

interface Props {
  src: string
  alt: string
  catalog?: MusicCatalog
  // Pass exactly one of these to enable the flip + editorial fetch
  albumId?: string
  playlistId?: string
  songId?: string
  // Fallback header text on the back side
  albumName?: string
  releaseYear?: number
  /** Override the default click-to-flip. Use this to keep external behavior
   *  (e.g. open a modal on desktop) — when provided, internal flip is disabled. */
  onClick?: () => void
  /** Tailwind classes applied to BOTH faces of the card (e.g. rounded-xl shadow-2xl
   *  inside the artwork modal; empty/undefined when rendering inline). */
  cardClassName?: string
  /** Outer perspective div style — set width/height here when not filling parent. */
  outerStyle?: CSSProperties
}

/** Flippable album-art card with editorial notes on the back. Front = artwork,
 *  back = Apple Music's editorial notes for the album/playlist (background
 *  color also pulled from the editorial data when available). Used inline by
 *  NowPlaying on mobile and inside the enlarged ArtworkModal on desktop. */
export function ArtworkFlip({
  src, alt, catalog, albumId, playlistId, songId, albumName, releaseYear,
  onClick, cardClassName, outerStyle,
}: Props) {
  const [flipped, setFlipped] = useState(false)
  const [bgColor, setBgColor] = useState("#111111")
  const [textColor, setTextColor] = useState("#ffffff")
  // undefined = not yet fetched, null = fetched but empty
  const [notes, setNotes] = useState<string | null | undefined>(undefined)
  const [fetchedAlbumName, setFetchedAlbumName] = useState<string | undefined>(undefined)
  const [fetchedReleaseYear, setFetchedReleaseYear] = useState<number | undefined>(undefined)

  // Reset flip when the underlying artwork changes (e.g. new track plays)
  useEffect(() => { setFlipped(false) }, [src])

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
        if (active) {
          setFetchedAlbumName(album.name)
          setFetchedReleaseYear(album.releaseYear)
        }
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

  const canFlip = !onClick && !!catalog && !!(albumId || playlistId || songId)
  const displayAlbumName = fetchedAlbumName ?? albumName
  const displayReleaseYear = fetchedReleaseYear ?? releaseYear
  const header = [displayAlbumName, displayReleaseYear].filter(Boolean).join("  ·  ")

  const handleClick = () => {
    if (onClick) onClick()
    else if (canFlip) setFlipped(f => !f)
  }

  return (
    <div style={{ perspective: "1200px", ...outerStyle }}>
      <div
        onClick={handleClick}
        style={{
          width: "100%",
          height: "100%",
          position: "relative",
          transformStyle: "preserve-3d",
          transition: "transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)",
          transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
          cursor: (onClick || canFlip) ? "pointer" : "default",
        }}
      >
        {/* Front: artwork */}
        <img
          src={src}
          alt={alt}
          className={`absolute inset-0 w-full h-full object-cover ${cardClassName ?? ""}`}
          style={{ backfaceVisibility: "hidden" }}
        />

        {/* Back: editorial notes / description */}
        <div
          className={`absolute inset-0 overflow-y-auto ${cardClassName ?? ""}`}
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
  )
}
