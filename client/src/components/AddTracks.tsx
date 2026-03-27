import { useState, useEffect, useRef, useCallback } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Trash2, ChevronRight, ChevronLeft, Disc3, ListMusic } from "lucide-react"
import { searchCatalog, getAlbumTracks, getPlaylistTracks, getLibraryPlaylists, getLibraryPlaylistTracks } from "../services/appleMusic"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import type { Track, SearchItem, AlbumResult, PlaylistResult, LibraryPlaylistResult, AppUser } from "../types"

type BrowseTarget = (AlbumResult | PlaylistResult | LibraryPlaylistResult) & { tracks: Track[] | null }

// ─── Search panel ─────────────────────────────────────────────────────────────

interface SearchProps {
  currentUser: AppUser
  onAddTrack: (track: Track) => void
  queuedCatalogIds: Set<string>
}

export function SearchTracks({ currentUser, onAddTrack, queuedCatalogIds }: SearchProps) {
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
        setSearchResults(await searchCatalog(query, currentUser.storefront))
      } finally {
        setSearching(false)
      }
    }, 350)

    return () => clearTimeout(debounceRef.current)
  }, [query, currentUser.storefront])

  async function handleBrowse(item: AlbumResult | PlaylistResult | LibraryPlaylistResult) {
    setBrowseTarget({ ...item, tracks: null })
    let tracks: Track[]
    if (item.kind === "album") {
      tracks = await getAlbumTracks(item.id, currentUser.storefront)
    } else if (item.kind === "library-playlist") {
      tracks = await getLibraryPlaylistTracks(item.id)
    } else {
      tracks = await getPlaylistTracks(item.id, currentUser.storefront)
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
            placeholder="Search Apple Music…"
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
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                <div className="w-12 h-12 rounded flex-shrink-0 overflow-hidden bg-surface">
                  {browseTarget.artworkUrl
                    ? <img src={artworkUrl(browseTarget.artworkUrl, 48)} alt="" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-muted">
                        {browseTarget.kind === "album" ? <Disc3 size={20} /> : <ListMusic size={20} />}
                      </div>
                  }
                </div>
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{browseTarget.name}</p>
                  <p className="text-muted text-xs truncate">{browseTarget.subtitle}</p>
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
                      key={track.catalogId}
                      track={track}
                      trackNumber={browseTarget.kind === "album" ? i + 1 : undefined}
                      added={queuedCatalogIds.has(track.catalogId)}
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
                  {searchResults.map((item) =>
                    item.kind === "song" ? (
                      <TrackRow
                        key={item.track.catalogId}
                        track={item.track}
                        added={queuedCatalogIds.has(item.track.catalogId)}
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

          {/* Empty state */}
          {!isSearching && !browseTarget && (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="p-6 text-center text-muted text-sm"
            >
              Search for songs, albums, or playlists
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  )
}

// ─── Pool + Library panel ─────────────────────────────────────────────────────

interface PoolLibraryProps {
  currentUser: AppUser
  stationOwner: string
  pool: Track[]
  onAddTrack: (track: Track) => void
  onRemoveFromPool: (catalogId: string) => void
  onClearPool: () => void
  queuedCatalogIds: Set<string>
}

export function PoolLibrary({ currentUser, stationOwner, pool, onAddTrack, onRemoveFromPool, onClearPool, queuedCatalogIds }: PoolLibraryProps) {
  const [tab, setTab] = useState<"pool" | "library">("pool")
  const [browseTarget, setBrowseTarget] = useState<BrowseTarget | null>(null)
  const [libraryPlaylists, setLibraryPlaylists] = useState<LibraryPlaylistResult[] | null>(null)
  const [loadingLibrary, setLoadingLibrary] = useState(false)
  const [playlistFilter, setPlaylistFilter] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)

  const isOwner = currentUser.uid === stationOwner

  async function handleShowLibrary() {
    setTab("library")
    if (libraryPlaylists !== null) return
    setLoadingLibrary(true)
    try {
      setLibraryPlaylists(await getLibraryPlaylists())
    } finally {
      setLoadingLibrary(false)
    }
  }

  async function handleBrowse(item: LibraryPlaylistResult) {
    savedScroll.current = scrollRef.current?.scrollTop ?? 0
    setBrowseTarget({ ...item, tracks: null })
    const tracks = await getLibraryPlaylistTracks(item.id)
    setBrowseTarget({ ...item, tracks })
  }

  const handleBack = useCallback(() => {
    setBrowseTarget(null)
    // restore after the exit animation clears
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = savedScroll.current
      })
    })
  }, [])

  return (
    <div className="bg-panel rounded-xl overflow-hidden flex flex-col">

      {/* Header */}
      <div className="border-b border-border">
        {browseTarget ? (
          <div className="px-4 py-3 text-xs text-muted font-medium flex items-center gap-2">
            <button
              onClick={handleBack}
              className="text-muted hover:text-white transition-colors flex items-center gap-1"
            >
              <ChevronLeft size={13} />
              Back
            </button>
            <span className="text-border">·</span>
            <span className="text-white normal-case font-normal truncate">{browseTarget.name}</span>
          </div>
        ) : (
          <div className="flex">
            {(["pool", "library"] as const).map(t => (
              <button
                key={t}
                onClick={() => t === "library" ? handleShowLibrary() : setTab("pool")}
                className={`flex-1 px-4 py-3 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  tab === t
                    ? "text-white border-accent"
                    : "text-muted hover:text-white border-transparent"
                }`}
              >
                {t === "pool" ? "Station Pool" : "My Playlists"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div ref={scrollRef} className="overflow-y-auto max-h-96">
        <AnimatePresence mode="wait">

          {/* Library playlist drilldown */}
          {browseTarget && (
            <motion.div
              key={`drilldown-${browseTarget.id}`}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.18 }}
            >
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                <div className="w-12 h-12 rounded flex-shrink-0 overflow-hidden bg-surface">
                  {browseTarget.artworkUrl
                    ? <img src={artworkUrl(browseTarget.artworkUrl, 48)} alt="" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-muted"><ListMusic size={20} /></div>
                  }
                </div>
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{browseTarget.name}</p>
                  <p className="text-muted text-xs truncate">{browseTarget.subtitle}</p>
                </div>
              </div>

              {browseTarget.tracks === null ? (
                <div className="p-6 text-center text-muted text-sm">Loading…</div>
              ) : browseTarget.tracks.length === 0 ? (
                <div className="p-6 text-center text-muted text-sm">No tracks found</div>
              ) : (
                <ul>
                  {browseTarget.tracks.map(track => (
                    <TrackRow
                      key={track.catalogId}
                      track={track}
                      added={queuedCatalogIds.has(track.catalogId)}
                      onAdd={() => onAddTrack(track)}
                    />
                  ))}
                </ul>
              )}
            </motion.div>
          )}

          {/* Station pool tab */}
          {!browseTarget && tab === "pool" && (
            <motion.div
              key="pool"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
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
                      {pool.map(track => (
                        <motion.li
                          key={track.catalogId}
                          layout
                          initial={{ opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
                          transition={{ duration: 0.2 }}
                        >
                          <TrackRow
                            track={track}
                            added={queuedCatalogIds.has(track.catalogId)}
                            onAdd={() => onAddTrack(track)}
                            onRemove={isOwner ? () => onRemoveFromPool(track.catalogId) : undefined}
                            unavailable={!isCatalogId(track.catalogId)}
                          />
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                </>
              )}
            </motion.div>
          )}

          {/* My Library tab */}
          {!browseTarget && tab === "library" && (
            <motion.div
              key="library"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {loadingLibrary ? (
                <div className="p-6 text-center text-muted text-sm">Loading…</div>
              ) : !libraryPlaylists || libraryPlaylists.length === 0 ? (
                <div className="p-6 text-center text-muted text-sm">No playlists found</div>
              ) : (
                <>
                  <div className="px-3 py-2 border-b border-border/50">
                    <div className="relative">
                      <input
                        type="text"
                        value={playlistFilter}
                        onChange={e => setPlaylistFilter(e.target.value)}
                        placeholder="Filter playlists…"
                        className="w-full bg-surface text-white placeholder-muted rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-accent pr-6"
                      />
                      {playlistFilter && (
                        <button
                          onClick={() => setPlaylistFilter("")}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-white transition-colors text-sm leading-none"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                  <ul>
                    {libraryPlaylists
                      .filter(pl => pl.name.toLowerCase().includes(playlistFilter.toLowerCase()))
                      .map(pl => (
                        <BrowsableRow key={pl.id} item={pl} onBrowse={() => handleBrowse(pl)} />
                      ))}
                  </ul>
                </>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

// Catalog IDs are numeric strings. Anything else (e.g. "i.xxx" library IDs)
// means the track can't be played from the catalog.
function isCatalogId(id: string) { return /^\d+$/.test(id) }

function TrackRow({ track, trackNumber, added, onAdd, onRemove, unavailable }: {
  track: Track
  trackNumber?: number
  added: boolean
  onAdd: () => void
  onRemove?: () => void
  unavailable?: boolean
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 group ${unavailable ? "opacity-50" : ""}`}>
      {trackNumber != null ? (
        <span className="text-xs text-muted w-5 text-right flex-shrink-0 tabular-nums">{trackNumber}</span>
      ) : (
        <div className="relative w-10 h-10 rounded flex-shrink-0 overflow-hidden bg-surface">
          {track.artworkUrl
            ? <img src={artworkUrl(track.artworkUrl, 40)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>
          }
          {unavailable && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-amber-400 text-xs font-bold">
              !
            </div>
          )}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate ${unavailable ? "text-muted line-through" : "text-white"}`}>{track.name}</p>
        <p className="text-muted text-xs truncate">
          {unavailable
            ? "No longer available"
            : trackNumber != null ? track.artistName : `${track.artistName} — ${track.albumName}`}
        </p>
      </div>

      <span className="text-xs text-muted tabular-nums flex-shrink-0">{formatDuration(track.durationMs)}</span>

      <div className="flex items-center gap-1 flex-shrink-0">
        {onRemove && (
          <button
            onClick={onRemove}
            className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-full flex items-center justify-center text-muted hover:text-red-400 transition-all"
            title="Remove from pool"
          >
            <Trash2 size={14} />
          </button>
        )}
        <button
          onClick={onAdd}
          disabled={added || unavailable}
          className={`w-7 h-7 rounded-full flex items-center justify-center text-sm transition-all ${
            added ? "bg-green-500/20 text-green-400" : unavailable ? "bg-surface text-muted cursor-not-allowed" : "bg-surface text-muted hover:bg-accent hover:text-white"
          }`}
          title={unavailable ? "No longer available" : "Add to queue"}
        >
          {added ? "✓" : "+"}
        </button>
      </div>
    </div>
  )
}

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
      <div className="w-10 h-10 rounded flex-shrink-0 overflow-hidden bg-surface">
        {item.artworkUrl
          ? <img src={artworkUrl(item.artworkUrl, 40)} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center text-muted">{icon}</div>
        }
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm truncate">{item.name}</p>
        {subtitle && <p className="text-muted text-xs truncate">{subtitle}</p>}
      </div>
      <ChevronRight size={16} className="text-muted group-hover:text-white transition-colors flex-shrink-0" />
    </button>
  )
}
