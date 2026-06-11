import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion } from "framer-motion"
import { X, ListMusic, Disc3, ChevronLeft } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import { LoadingDots } from "./LoadingDots"
import { ArtworkModal } from "./ArtworkModal"
import { relativeTime } from "../utils"
import type { Track, PlaylistResult, LibraryPlaylistResult, AlbumResult, LibraryAlbumResult } from "../types"
import type { MusicCatalog } from "../services/catalog"

type NavEntry = { playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult | LibraryAlbumResult; tracks: Track[] | null; scrollTop: number }

interface Props {
  playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult | LibraryAlbumResult
  tracks: Track[] | null
  queuedIsrcs: Set<string>
  /** When omitted (e.g. legacy callers without a station-active concept),
   *  no row is rendered as the now-playing track. */
  nowPlayingIds?: Set<string>
  onAddTrack: (track: Track) => void
  onClose: () => void
  catalog?: MusicCatalog
  djNotes?: Record<string, string>
  onSaveDjNote?: (itemId: string, note: string) => void
}

const EMPTY_SET = new Set<string>()

export function PlaylistModal({ playlist, tracks, queuedIsrcs, nowPlayingIds = EMPTY_SET, onAddTrack, onClose, catalog, djNotes, onSaveDjNote }: Props) {
  const [navStack, setNavStack] = useState<NavEntry[]>([])
  const [navCurrent, setNavCurrent] = useState<NavEntry | null>(null)
  const [artworkOpen, setArtworkOpen] = useState(false)
  const closeArtwork = useCallback(() => setArtworkOpen(false), [])
  const navOpRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoreScrollRef = useRef<number | null>(null)

  const isAtRoot = navStack.length === 0
  const displayPlaylist = isAtRoot ? playlist : navCurrent!.playlist
  const displayTracks = isAtRoot ? tracks : navCurrent!.tracks
  const isAlbumish = displayPlaylist.kind === "album" || displayPlaylist.kind === "library-album"

  // Restore scroll position after nav changes settle
  useEffect(() => {
    if (restoreScrollRef.current !== null && scrollRef.current) {
      scrollRef.current.scrollTop = restoreScrollRef.current
      restoreScrollRef.current = null
    }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !artworkOpen) onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose, artworkOpen])

  async function handleTrackAlbumClick(track: Track) {
    if (!catalog || !track.appleId) return
    const op = ++navOpRef.current

    const album = await catalog.getAlbumForTrack(track.appleId)
    if (navOpRef.current !== op || !album) return

    const savedScroll = scrollRef.current?.scrollTop ?? 0
    setNavStack(prev => [...prev, { playlist: displayPlaylist, tracks: displayTracks, scrollTop: savedScroll }])
    setNavCurrent({ playlist: album, tracks: null, scrollTop: 0 })
    restoreScrollRef.current = 0

    const albumTracks = await catalog.getAlbumTracks(album.id)
    if (navOpRef.current === op) {
      setNavCurrent({ playlist: album, tracks: albumTracks, scrollTop: 0 })
    }
  }

  function navigateBack() {
    ++navOpRef.current
    const prevEntry = navStack[navStack.length - 1]
    setNavStack(prev => prev.slice(0, -1))
    setNavCurrent(navStack.length <= 1 ? null : prevEntry)
    restoreScrollRef.current = prevEntry.scrollTop
  }

  return createPortal(
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="w-full max-w-lg bg-panel rounded-xl overflow-hidden flex flex-col h-[80vh]"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-4 px-4 py-4 border-b border-border bg-surface/40 flex-shrink-0">
          {navStack.length > 0 && (
            <button onClick={navigateBack} className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0">
              <ChevronLeft size={18} />
            </button>
          )}
          <div className="w-16 h-16 rounded-lg flex-shrink-0 overflow-hidden bg-surface">
            {displayPlaylist.artworkUrl
              ? <button onClick={() => setArtworkOpen(true)} className="block w-full h-full cursor-zoom-in">
                  <img src={artworkUrl(displayPlaylist.artworkUrl, 64)} alt="" className="w-full h-full object-cover" />
                </button>
              : <div className="w-full h-full flex items-center justify-center text-muted">
                  {isAlbumish ? <Disc3 size={20} /> : <ListMusic size={20} />}
                </div>
            }
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-base font-bold">{displayPlaylist.name}</p>
            {displayPlaylist.subtitle && <p className="text-muted text-sm truncate mt-0.5">{displayPlaylist.subtitle}</p>}
            <div className="flex items-center gap-2 mt-0.5">
              {displayTracks !== null && (() => {
                const available = displayTracks.filter(t => t.appleId).length
                const total = displayTracks.length
                const label = available < total
                  ? `${available} of ${total} tracks available`
                  : `${total} track${total !== 1 ? "s" : ""}`
                return <p className="text-muted text-xs opacity-60">{label}</p>
              })()}
              {displayPlaylist.kind === "album" && displayPlaylist.releaseYear && (
                <p className="text-muted text-xs opacity-60">{displayPlaylist.releaseYear}</p>
              )}
              {(displayPlaylist.kind === "playlist" || displayPlaylist.kind === "library-playlist") && displayPlaylist.lastModifiedAt && (
                <p className="text-muted text-xs opacity-60">Updated {relativeTime(displayPlaylist.lastModifiedAt)}</p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0">
            <X size={18} />
          </button>
        </div>

        {/* Track list */}
        <div ref={scrollRef} className="overflow-y-auto flex-1 min-h-0">
          {displayTracks === null ? (
            <div className="p-6 text-center text-muted text-sm"><LoadingDots /></div>
          ) : displayTracks.length === 0 ? (
            <div className="p-6 text-center text-muted text-sm">No tracks found</div>
          ) : (
            <ul>
              {displayTracks.map((track, i) => {
                const isUnavailable = !track.appleId
                return (
                  <TrackRow
                    key={track.appleId ?? track.isrc ?? track.name}
                    track={track}
                    trackNumber={isAlbumish ? i + 1 : undefined}
                    hideArtist={isAlbumish && track.artistName === displayPlaylist.subtitle}
                    added={!isUnavailable && (queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.appleId ?? ""))}
                    isNowPlaying={nowPlayingIds.has(track.isrc) || nowPlayingIds.has(track.appleId ?? "")}
                    unavailable={isUnavailable}
                    onAdd={() => onAddTrack(track)}
                    onAlbumClick={catalog && track.appleId && !isAlbumish
                      ? () => handleTrackAlbumClick(track)
                      : undefined}
                  />
                )
              })}
            </ul>
          )}
        </div>

        {/* Footer — Add all */}
        {displayTracks && displayTracks.length > 0 && (() => {
          // Exclude tracks already queued by the user AND the now-playing
          // track (server would refuse to add it; we shouldn't try). Robot-
          // queued tracks remain addable — server promotes them.
          const unqueued = displayTracks.filter(t =>
            t.appleId &&
            !queuedIsrcs.has(t.isrc) && !queuedIsrcs.has(t.appleId) &&
            !nowPlayingIds.has(t.isrc) && !nowPlayingIds.has(t.appleId)
          )
          return unqueued.length > 0 ? (
            <div className="border-t border-border flex-shrink-0">
              <button
                onClick={() => unqueued.forEach(onAddTrack)}
                className="w-full px-4 py-3 text-sm text-muted hover:text-white font-medium transition-colors text-left"
              >
                + Add all {unqueued.length} tracks
              </button>
            </div>
          ) : null
        })()}
      </motion.div>

      <AnimatePresence>
        {artworkOpen && displayPlaylist.artworkUrl && (
          <ArtworkModal
            src={artworkUrl(displayPlaylist.artworkUrl, 750)}
            alt={displayPlaylist.name}
            onClose={closeArtwork}
            catalog={catalog}
            albumId={displayPlaylist.kind === "album" ? displayPlaylist.id : undefined}
            playlistId={
              displayPlaylist.kind === "playlist" ? displayPlaylist.id
              // Subscribed library playlists have a catalog counterpart with full editorial
              : displayPlaylist.kind === "library-playlist" ? displayPlaylist.catalogId
              : undefined
            }
            fallbackNotes={displayPlaylist.kind === "library-playlist" ? displayPlaylist.description : undefined}
            albumName={displayPlaylist.name}
            releaseYear={displayPlaylist.kind === "album" ? displayPlaylist.releaseYear : undefined}
            djNotes={djNotes}
            onSaveDjNote={onSaveDjNote}
          />
        )}
      </AnimatePresence>
    </motion.div>,
    document.body
  )
}
