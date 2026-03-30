import { useState, useEffect, useRef } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Trash2, ChevronRight, ChevronLeft, Disc3, ListMusic } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import type { MusicCatalog } from "../services/catalog"
import type { Track, SearchItem, AlbumResult, PlaylistResult, LibraryPlaylistResult, AppUser } from "../types"

type BrowseTarget = (AlbumResult | PlaylistResult | LibraryPlaylistResult) & { tracks: Track[] | null }

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
  const [browseTarget, setBrowseTarget] = useState<BrowseTarget | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const isSearching = query.trim().length > 0

  useEffect(() => {
    clearTimeout(debounceRef.current)
    setBrowseTarget(null)
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
    setBrowseTarget({ ...item, tracks: null })
    let tracks: Track[]
    if (item.kind === "album") {
      tracks = await catalog.getAlbumTracks(item.id)
    } else if (item.kind === "library-playlist") {
      tracks = await catalog.getLibraryPlaylistTracks(item.id)
    } else {
      tracks = await catalog.getPlaylistTracks(item.id)
    }
    setBrowseTarget({ ...item, tracks })
  }

  return (
    <div className="bg-panel rounded-xl overflow-hidden flex flex-col">

      {/* Header */}
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider flex items-center gap-2">
        {browseTarget ? (
          <>
            <button
              onClick={() => setBrowseTarget(null)}
              className="text-muted hover:text-white transition-colors flex items-center gap-1"
            >
              <ChevronLeft size={13} />
              Back
            </button>
            <span className="text-border">·</span>
            <span className="text-white normal-case font-normal truncate">{browseTarget.name}</span>
          </>
        ) : (
          <span>Search</span>
        )}
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
          {(query || browseTarget) && (
            <button
              onClick={() => { setQuery(""); setBrowseTarget(null) }}
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

          {/* Drilldown */}
          {browseTarget && (
            <motion.div
              key={`drilldown-${browseTarget.id}`}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.18 }}
            >
              <div className="flex items-center gap-4 px-4 py-4 border-b border-border bg-surface/40">
                <div className="w-32 h-32 rounded-lg flex-shrink-0 overflow-hidden bg-surface shadow-md">
                  {browseTarget.artworkUrl
                    ? <img src={artworkUrl(browseTarget.artworkUrl, 128)} alt="" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-muted">
                        {browseTarget.kind === "album" ? <Disc3 size={24} /> : <ListMusic size={24} />}
                      </div>
                  }
                </div>
                <div className="min-w-0">
                  <p className="text-white text-base font-bold truncate">{browseTarget.name}</p>
                  {browseTarget.subtitle && <p className="text-muted text-sm truncate mt-0.5">{browseTarget.subtitle}</p>}
                </div>
              </div>

              {browseTarget.tracks === null ? (
                <div className="p-6 text-center text-muted text-sm">Loading…</div>
              ) : browseTarget.tracks.length === 0 ? (
                <div className="p-6 text-center text-muted text-sm">No tracks found</div>
              ) : (
                <ul>
                  {browseTarget.tracks.map((track, i) => (
                    <TrackRow
                      key={track.platformIds?.apple || track.isrc || track.name}
                      track={track}
                      trackNumber={browseTarget.kind === "album" ? i + 1 : undefined}
                      added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                      onAdd={() => onAddTrack(track)}
                    />
                  ))}
                </ul>
              )}
            </motion.div>
          )}

          {/* Search results */}
          {isSearching && !browseTarget && (
            <motion.div
              key="search"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {searching ? (
                <div className="p-6 text-center text-muted text-sm">Searching…</div>
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
      <div className="overflow-y-auto max-h-96">
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
