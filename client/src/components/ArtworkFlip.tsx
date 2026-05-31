import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import type { MusicCatalog } from "../services/catalog"

const DJ_NOTE_MAX = 2500

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
  /** Map of itemId → note text received from the server. */
  djNotes?: Record<string, string>
  /** Called when a privileged user saves a note. Presence gates editability. */
  onSaveDjNote?: (itemId: string, note: string) => void
}

/** Flippable album-art card with editorial notes on the back. Front = artwork,
 *  back = Apple Music's editorial notes for the album/playlist (background
 *  color also pulled from the editorial data when available). Used inline by
 *  NowPlaying on mobile and inside the enlarged ArtworkModal on desktop. */
export function ArtworkFlip({
  src, alt, catalog, albumId, playlistId, songId, albumName, releaseYear,
  onClick, cardClassName, outerStyle, djNotes, onSaveDjNote,
}: Props) {
  const [flipped, setFlipped] = useState(false)
  const [bgColor, setBgColor] = useState("#111111")
  const [textColor, setTextColor] = useState("#ffffff")
  // undefined = not yet fetched, null = fetched but empty
  const [notes, setNotes] = useState<string | null | undefined>(undefined)
  const [fetchedAlbumName, setFetchedAlbumName] = useState<string | undefined>(undefined)
  const [fetchedReleaseYear, setFetchedReleaseYear] = useState<number | undefined>(undefined)
  const [fetchedAlbumId, setFetchedAlbumId] = useState<string | undefined>(undefined)

  const [draftNote, setDraftNote] = useState("")
  const [noteFocused, setNoteFocused] = useState(false)
  const [editingNote, setEditingNote] = useState(false)
  const noteRef = useRef<HTMLTextAreaElement>(null)

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
          setFetchedAlbumId(album.id)
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

  const noteKey = fetchedAlbumId ?? albumId ?? playlistId
  const savedNote = (noteKey && djNotes?.[noteKey]) ?? ""

  // Sync draftNote from server value; don't override if user is actively editing
  useEffect(() => { setDraftNote(savedNote) }, [savedNote])

  const canFlip = !onClick && !!catalog && !!(albumId || playlistId || songId)
  const displayAlbumName = fetchedAlbumName ?? albumName
  const displayReleaseYear = fetchedReleaseYear ?? releaseYear
  const header = [displayAlbumName, displayReleaseYear].filter(Boolean).join("  ·  ")

  const handleClick = () => {
    if (onClick) onClick()
    else if (canFlip) setFlipped(f => !f)
  }

  const showDJSection = !!noteKey && (!!onSaveDjNote || !!savedNote)

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

            {showDJSection && (
              <div className="mt-5">
                {onSaveDjNote && editingNote ? (
                  <>
                    <textarea
                      ref={noteRef}
                      autoFocus
                      value={draftNote}
                      onChange={e => setDraftNote(e.target.value.slice(0, DJ_NOTE_MAX))}
                      onFocus={() => setNoteFocused(true)}
                      onBlur={() => setNoteFocused(false)}
                      onClick={e => e.stopPropagation()}
                      placeholder="Add a note for this album…"
                      rows={4}
                      className="w-full bg-black/40 rounded-lg px-3 py-2 text-2xl font-semibold leading-snug resize-none outline-none focus:ring-1 focus:ring-white/40 placeholder-white/25"
                      style={{ color: textColor }}
                    />
                    {noteFocused && (
                      <div className="flex justify-between items-center mt-1.5">
                        <button
                          onMouseDown={e => e.preventDefault()}
                          onClick={e => {
                            e.stopPropagation()
                            onSaveDjNote(noteKey, draftNote.trim())
                            setEditingNote(false)
                            noteRef.current?.blur()
                          }}
                          className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors font-medium"
                          style={{ color: textColor }}
                        >
                          Save
                        </button>
                        <span className="text-xs opacity-30" style={{ color: textColor }}>
                          {draftNote.length}/{DJ_NOTE_MAX}
                        </span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {savedNote && (
                      <p className="text-2xl font-semibold leading-snug whitespace-pre-line rounded-lg border border-white/10 px-3 py-2" style={{ color: textColor, opacity: 0.8 }}>
                        {savedNote}
                      </p>
                    )}
                    {onSaveDjNote && (
                      <button
                        onClick={e => { e.stopPropagation(); setDraftNote(savedNote); setEditingNote(true) }}
                        className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors font-medium"
                        style={{ color: textColor }}
                      >
                        {savedNote ? "Edit" : "Add note"}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
