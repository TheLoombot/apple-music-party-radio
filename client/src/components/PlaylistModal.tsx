import { useEffect, useRef, useState } from "react"
import { motion } from "framer-motion"
import { X, ListMusic, Disc3, ChevronLeft } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import { LoadingDots } from "./LoadingDots"
import { relativeTime } from "../utils"
import type { Track, PlaylistResult, LibraryPlaylistResult, AlbumResult } from "../types"
import type { MusicCatalog } from "../services/catalog"

type NavEntry = { playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult; tracks: Track[] | null; scrollTop: number }

interface Props {
  playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult
  tracks: Track[] | null
  queuedIsrcs: Set<string>
  onAddTrack: (track: Track) => void
  onClose: () => void
  catalog?: MusicCatalog
}

export function PlaylistModal({ playlist, tracks, queuedIsrcs, onAddTrack, onClose, catalog }: Props) {
  const [navStack, setNavStack] = useState<NavEntry[]>([])
  const [navCurrent, setNavCurrent] = useState<NavEntry | null>(null)
  const navOpRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoreScrollRef = useRef<number | null>(null)

  const isAtRoot = navStack.length === 0
  const displayPlaylist = isAtRoot ? playlist : navCurrent!.playlist
  const displayTracks = isAtRoot ? tracks : navCurrent!.tracks

  // Restore scroll position after nav changes settle
  useEffect(() => {
    if (restoreScrollRef.current !== null && scrollRef.current) {
      scrollRef.current.scrollTop = restoreScrollRef.current
      restoreScrollRef.current = null
    }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  async function handleTrackAlbumClick(track: Track) {
    if (!catalog || !track.platformIds?.apple) return
    const op = ++navOpRef.current

    const album = await catalog.getAlbumForTrack(track.platformIds.apple)
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

  return (
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
            <button onClick={navigateBack} className="text-muted hover:text-white transition-colors flex-shrink-0 p-1">
              <ChevronLeft size={18} />
            </button>
          )}
          <div className="w-16 h-16 rounded-lg flex-shrink-0 overflow-hidden bg-surface">
            {displayPlaylist.artworkUrl
              ? <img src={artworkUrl(displayPlaylist.artworkUrl, 64)} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-muted">
                  {displayPlaylist.kind === "album" ? <Disc3 size={20} /> : <ListMusic size={20} />}
                </div>
            }
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-base font-bold">{displayPlaylist.name}</p>
            {displayPlaylist.subtitle && <p className="text-muted text-sm truncate mt-0.5">{displayPlaylist.subtitle}</p>}
            {displayPlaylist.kind === "album" && displayPlaylist.releaseYear && (
              <p className="text-muted text-xs mt-0.5 opacity-60">{displayPlaylist.releaseYear}</p>
            )}
            {(displayPlaylist.kind === "playlist" || displayPlaylist.kind === "library-playlist") && displayPlaylist.lastModifiedAt && (
              <p className="text-muted text-xs mt-0.5 opacity-60">Updated {relativeTime(displayPlaylist.lastModifiedAt)}</p>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors flex-shrink-0 p-1">
            <X size={18} />
          </button>
        </div>

        {/* Track list */}
        <div ref={scrollRef} className="overflow-y-auto flex-1">
          {displayTracks === null ? (
            <div className="p-6 text-center text-muted text-sm"><LoadingDots /></div>
          ) : displayTracks.length === 0 ? (
            <div className="p-6 text-center text-muted text-sm">No tracks found</div>
          ) : (
            <ul>
              {displayTracks.map((track, i) => (
                <TrackRow
                  key={track.platformIds?.apple ?? track.isrc ?? track.name}
                  track={track}
                  trackNumber={displayPlaylist.kind === "album" ? i + 1 : undefined}
                  hideArtist={displayPlaylist.kind === "album" && track.artistName === displayPlaylist.subtitle}
                  added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                  onAdd={() => onAddTrack(track)}
                  onAlbumClick={catalog && track.platformIds?.apple && displayPlaylist.kind !== "album"
                    ? () => handleTrackAlbumClick(track)
                    : undefined}
                />
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
