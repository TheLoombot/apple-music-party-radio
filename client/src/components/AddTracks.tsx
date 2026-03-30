import { useState, useEffect, useRef } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Trash2, ChevronRight, Disc3, ListMusic } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import { PlaylistModal } from "./PlaylistModal"
import { LoadingDots } from "./LoadingDots"
import type { MusicCatalog } from "../services/catalog"
import type { Track, SearchItem, AlbumResult, PlaylistResult, LibraryPlaylistResult, AppUser } from "../types"

type ModalState = (AlbumResult | PlaylistResult | LibraryPlaylistResult) & { tracks: Track[] | null }

// ─── Search panel ─────────────────────────────────────────────────────────────

interface SearchProps {
  currentUser: AppUser
  catalog: MusicCatalog
  onAddTrack: (track: Track) => void
  queuedIsrcs: Set<string>
}

export function SearchTracks({ currentUser, catalog, onAddTrack, queuedIsrcs }: SearchProps) {
  const [query, setQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const [modal, setModal] = useState<ModalState | null>(null)
  const modalOpRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const isSearching = query.trim().length > 0

  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (!isSearching) { setSearchResults([]); return }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        setSearchResults(await catalog.search(query))
      } finally {
        setSearching(false)
      }
    }, 350)

    return () => clearTimeout(debounceRef.current)
  }, [query, catalog])

  async function handleBrowse(item: AlbumResult | PlaylistResult | LibraryPlaylistResult) {
    const op = ++modalOpRef.current
    setModal({ ...item, tracks: null })
    const tracks = item.kind === "album"
      ? await catalog.getAlbumTracks(item.id)
      : item.kind === "library-playlist"
      ? await catalog.getLibraryPlaylistTracks(item.id)
      : await catalog.getPlaylistTracks(item.id)
    if (modalOpRef.current === op) setModal({ ...item, tracks })
  }

  async function handleAlbumClick(track: Track) {
    if (!track.platformIds?.apple) return
    const op = ++modalOpRef.current
    const placeholder: AlbumResult = { kind: "album", id: "_loading", name: track.albumName, subtitle: track.artistName, artworkUrl: track.artworkUrl }
    setModal({ ...placeholder, tracks: null })
    const album = await catalog.getAlbumForTrack(track.platformIds.apple)
    if (modalOpRef.current !== op) return
    if (!album) { setModal(null); return }
    setModal({ ...album, tracks: null })
    const tracks = await catalog.getAlbumTracks(album.id)
    if (modalOpRef.current === op) setModal({ ...album, tracks })
  }

  return (
    <>
      <div className="bg-panel rounded-xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
          Search
        </div>

        {/* Search input */}
        <div className="p-3 border-b border-border">
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search music…"
              className="w-full bg-surface text-white placeholder-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent pr-8"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-white text-lg leading-none"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Results */}
        <div className="overflow-y-auto max-h-96">
          <AnimatePresence mode="wait">
            {isSearching && (
              <motion.div
                key="search"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {searching ? (
                  <div className="p-6 text-center text-muted text-sm"><LoadingDots /></div>
                ) : searchResults.length === 0 ? (
                  <div className="p-6 text-center text-muted text-sm">No results</div>
                ) : (
                  <ul>
                    {searchResults.filter((item, i, arr) => {
                      if (item.kind !== "song") return true
                      return arr.findIndex(x => x.kind === "song" && (x.track.isrc || x.track.platformIds?.apple) === (item.track.isrc || item.track.platformIds?.apple)) === i
                    }).map((item) =>
                      item.kind === "song" ? (
                        <TrackRow
                          key={item.track.platformIds?.apple || item.track.isrc || item.track.name}
                          track={item.track}
                          added={queuedIsrcs.has(item.track.isrc) || queuedIsrcs.has(item.track.platformIds?.apple ?? "")}
                          onAdd={() => onAddTrack(item.track)}
                          onAlbumClick={item.track.platformIds?.apple ? () => handleAlbumClick(item.track) : undefined}
                        />
                      ) : (
                        <BrowsableRow
                          key={item.id}
                          item={item}
                          onBrowse={() => handleBrowse(item)}
                        />
                      )
                    )}
                  </ul>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {modal && (
          <PlaylistModal
            playlist={modal}
            tracks={modal.tracks}
            queuedIsrcs={queuedIsrcs}
            onAddTrack={onAddTrack}
            onClose={() => { modalOpRef.current++; setModal(null) }}
            catalog={catalog}
          />
        )}
      </AnimatePresence>
    </>
  )
}

// ─── Station Pool panel ───────────────────────────────────────────────────────

interface StationPoolProps {
  currentUser: AppUser
  stationOwner: string
  pool: Track[]
  onAddTrack: (track: Track) => void
  onRemoveFromPool: (isrc: string) => void
  onClearPool: () => void
  queuedIsrcs: Set<string>
}

export function StationPool({ currentUser, stationOwner, pool, onAddTrack, onRemoveFromPool, onClearPool, queuedIsrcs }: StationPoolProps) {
  const isOwner = currentUser.uid === stationOwner

  return (
    <div className="bg-panel rounded-xl overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
        Station Pool
      </div>
      <div className="overflow-y-auto h-[360px]">
        {pool.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">
            <p>Nothing in the pool yet.</p>
            <p className="text-xs mt-1 opacity-60">Tracks land here after they finish playing.</p>
          </div>
        ) : (
          <>
            <div className="px-4 py-2 text-xs text-muted border-b border-border/50 flex items-center justify-between">
              <span>{pool.length} track{pool.length !== 1 ? "s" : ""}</span>
              {isOwner && (
                <button
                  onClick={onClearPool}
                  className="flex items-center gap-1 text-muted hover:text-red-400 transition-colors"
                  title="Clear entire pool"
                >
                  <Trash2 size={11} />
                  <span>Clear all</span>
                </button>
              )}
            </div>
            <ul>
              <AnimatePresence initial={false}>
                {pool.filter((t, i, arr) => {
                  const k = t.isrc || t.platformIds?.apple || t.name
                  return arr.findIndex(x => (x.isrc || x.platformIds.apple || x.name) === k) === i
                }).map(track => (
                  <motion.li
                    key={track.isrc || track.platformIds?.apple || track.name}
                    layout
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
                    transition={{ duration: 0.2 }}
                  >
                    <TrackRow
                      track={track}
                      added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                      onAdd={() => onAddTrack(track)}
                      onRemove={isOwner ? () => onRemoveFromPool(track.isrc) : undefined}
                      unavailable={!track.platformIds?.apple}
                    />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function BrowsableRow({ item, onBrowse }: {
  item: AlbumResult | PlaylistResult | LibraryPlaylistResult
  onBrowse: () => void
}) {
  const icon = item.kind === "album" ? <Disc3 size={16} /> : <ListMusic size={16} />

  let subtitle: string
  if (item.kind === "library-playlist") {
    const count = item.trackCount != null ? `${item.trackCount} track${item.trackCount !== 1 ? "s" : ""}` : null
    subtitle = item.subtitle && count ? `${item.subtitle} — ${count}`
             : item.subtitle ? item.subtitle
             : count ?? "Playlist"
  } else {
    subtitle = item.kind === "album" ? (item.subtitle ?? "") : `${item.subtitle} — Playlist`
  }

  return (
    <button
      onClick={onBrowse}
      className="w-full flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 text-left group"
    >
      <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
        {item.artworkUrl
          ? <img src={artworkUrl(item.artworkUrl, 96)} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center text-muted">{icon}</div>
        }
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-base truncate">{item.name}</p>
        {subtitle && <p className="text-muted text-sm truncate">{subtitle}</p>}
      </div>
      <ChevronRight size={16} className="text-muted group-hover:text-white transition-colors flex-shrink-0" />
    </button>
  )
}
