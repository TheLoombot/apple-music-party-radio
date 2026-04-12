import { useEffect, useState, useRef } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { ChevronRight, ListMusic } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import { PlaylistModal } from "./PlaylistModal"
import { LoadingDots } from "./LoadingDots"
import type { MusicCatalog } from "../services/catalog"
import type { Track, PlaylistResult, LibraryPlaylistResult, AlbumResult, QueueItem, SearchItem } from "../types"

type Tab = "search" | "related" | "charts" | "mfy" | "playlists"
type ModalState = { playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult; tracks: Track[] | null }

function pickRandom<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n)
}

interface Props {
  catalog: MusicCatalog
  queuedIsrcs: Set<string>
  queue: QueueItem[]
  onAddTrack: (track: Track) => void
}

export function Discovery({ catalog, queuedIsrcs, queue, onAddTrack }: Props) {
  const [tab, setTab] = useState<Tab>("search")

  // ── Search tab state ────────────────────────────────────────────────────────
  const [query, setQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchItem[]>([])
  const [searching, setSearching] = useState(false)
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

  // ── Charts / MFY state ──────────────────────────────────────────────────────
  const [chartTracks, setChartTracks] = useState<Track[]>([])
  const [chartsLoading, setChartsLoading] = useState(true)

  const allPlaylists = useRef<(PlaylistResult | AlbumResult)[]>([])
  const [playlists, setPlaylists] = useState<(PlaylistResult | AlbumResult)[]>([])
  const [mfyLoading, setMfyLoading] = useState(true)

  const [modal, setModal] = useState<ModalState | null>(null)
  const modalOpRef = useRef(0)

  // ── Related tab state ───────────────────────────────────────────────────────
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [relatedTracks, setRelatedTracks] = useState<Track[]>([])
  const [relatedSeed, setRelatedSeed] = useState<{ name: string; artistName: string } | null>(null)
  const [relatedPlaylist, setRelatedPlaylist] = useState<PlaylistResult | null>(null)
  const [relatedError, setRelatedError] = useState(false)
  const allRelatedPlaylists = useRef<PlaylistResult[]>([])

  // ── Playlists tab state ─────────────────────────────────────────────────────
  const [libraryPlaylists, setLibraryPlaylists] = useState<LibraryPlaylistResult[] | null>(null)
  const [loadingLibrary, setLoadingLibrary] = useState(false)
  const [playlistFilter, setPlaylistFilter] = useState("")
  const playlistScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    catalog.getCharts().then(c => {
      setChartTracks(c[0]?.tracks ?? [])
      setChartsLoading(false)
    })
    catalog.getRecommendedPlaylists().then(p => {
      allPlaylists.current = p
      setPlaylists(pickRandom(p, 3))
      setMfyLoading(false)
    })
  }, [catalog])

  const refreshMfy = () => setPlaylists(pickRandom(allPlaylists.current, 3))

  const handleSelectPlaylist = async (playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult) => {
    const op = ++modalOpRef.current
    setModal({ playlist, tracks: null })
    const tracks = playlist.kind === "library-playlist"
      ? await catalog.getLibraryPlaylistTracks(playlist.id)
      : playlist.kind === "album"
      ? await catalog.getAlbumTracks(playlist.id)
      : await catalog.getPlaylistTracks(playlist.id)
    if (modalOpRef.current === op) setModal({ playlist, tracks })
  }

  const handleAlbumClick = async (track: Track) => {
    if (!track.platformIds?.apple) return
    const op = ++modalOpRef.current
    const placeholder: AlbumResult = { kind: "album", id: "_loading", name: track.albumName, subtitle: track.artistName, artworkUrl: track.artworkUrl }
    setModal({ playlist: placeholder, tracks: null })
    const album = await catalog.getAlbumForTrack(track.platformIds.apple)
    if (modalOpRef.current !== op) return
    if (!album) { setModal(null); return }
    setModal({ playlist: album, tracks: null })
    const tracks = await catalog.getAlbumTracks(album.id)
    if (modalOpRef.current === op) setModal({ playlist: album, tracks })
  }

  async function loadRelated(forceNew = false) {
    const candidates = queue.filter(t => t.platformIds?.apple)
    if (candidates.length === 0) { setRelatedError(true); return }

    const seed = candidates[Math.floor(Math.random() * candidates.length)]
    setRelatedSeed({ name: seed.name, artistName: seed.artistName })
    setRelatedLoading(true)
    setRelatedError(false)
    setRelatedTracks([])

    try {
      if (forceNew || allRelatedPlaylists.current.length === 0) {
        const pls = await catalog.getRelatedPlaylists(seed.platformIds.apple!)
        allRelatedPlaylists.current = pls
      }
      if (allRelatedPlaylists.current.length === 0) { setRelatedError(true); return }

      const playlist = pickRandom(allRelatedPlaylists.current, 1)[0]
      setRelatedPlaylist(playlist)
      const tracks = await catalog.getPlaylistTracks(playlist.id)
      setRelatedTracks(pickRandom(tracks, 3))
    } catch {
      setRelatedError(true)
    } finally {
      setRelatedLoading(false)
    }
  }

  const refreshRelated = () => {
    allRelatedPlaylists.current = []
    loadRelated(true)
  }

  const relatedLoadedRef = useRef(false)

  useEffect(() => {
    if (tab !== "related" || relatedLoadedRef.current || queue.length === 0) return
    relatedLoadedRef.current = true
    allRelatedPlaylists.current = []
    loadRelated(true)
  }, [queue.length === 0])

  const handleTabChange = (t: Tab) => {
    setTab(t)
    if (t === "related" && !relatedLoadedRef.current && queue.length > 0) {
      relatedLoadedRef.current = true
      allRelatedPlaylists.current = []
      loadRelated(true)
    }
    if (t === "playlists" && libraryPlaylists === null && !loadingLibrary) {
      setLoadingLibrary(true)
      catalog.getLibraryPlaylists().then(p => {
        setLibraryPlaylists(p)
        setLoadingLibrary(false)
      })
    }
  }

  const TAB_LABELS: Record<Tab, string> = {
    search: "Search",
    related: "Related",
    charts: "Top 20",
    mfy: "Top Picks",
    playlists: "Playlists",
  }

  return (
    <>
      <div className="bg-panel rounded-xl overflow-hidden">
        {/* Static header */}
        <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
          Add or Request
        </div>

        {/* Tab bar */}
        <div className="border-b border-border">
          <div className="flex items-center">
            {(["search", "related", "charts", "mfy", "playlists"] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => handleTabChange(t)}
                className={`flex-1 px-1 py-2.5 text-[10px] font-medium transition-colors border-b-2 -mb-px ${
                  tab === t ? "text-white border-accent" : "text-muted hover:text-white border-transparent"
                }`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {tab === "search" ? (
          <>
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
            <div className="overflow-y-auto h-96">
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
                        {searchResults
                          .filter((item, i, arr) => {
                            if (item.kind !== "song") return true
                            return arr.findIndex(x =>
                              x.kind === "song" &&
                              (x.track.isrc || x.track.platformIds?.apple) === (item.track.isrc || item.track.platformIds?.apple)
                            ) === i
                          })
                          .map(item =>
                            item.kind === "song" ? (
                              <TrackRow
                                key={item.track.platformIds?.apple || item.track.isrc || item.track.name}
                                track={item.track}
                                added={queuedIsrcs.has(item.track.isrc) || queuedIsrcs.has(item.track.platformIds?.apple ?? "")}
                                onAdd={() => onAddTrack(item.track)}
                                onAlbumClick={item.track.platformIds?.apple ? () => handleAlbumClick(item.track) : undefined}
                              />
                            ) : (
                              <PlaylistRow
                                key={item.id}
                                playlist={item}
                                onSelect={() => handleSelectPlaylist(item)}
                              />
                            )
                          )}
                      </ul>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        ) : tab === "charts" ? (
          <div className="h-[360px] overflow-y-auto">
            {chartsLoading ? (
              <div className="p-6 text-center text-muted text-sm"><LoadingDots /></div>
            ) : chartTracks.length === 0 ? (
              <div className="p-6 text-center text-muted text-sm">No chart data available</div>
            ) : (
              <ul>
                {chartTracks.map((track, i) => (
                  <TrackRow
                    key={track.platformIds?.apple ?? track.isrc}
                    track={track}
                    rankNumber={i + 1}
                    added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                    onAdd={() => onAddTrack(track)}
                    onAlbumClick={track.platformIds?.apple ? () => handleAlbumClick(track) : undefined}
                  />
                ))}
              </ul>
            )}
          </div>
        ) : tab === "mfy" ? (
          mfyLoading ? (
            <div className="p-6 text-center text-muted text-sm"><LoadingDots /></div>
          ) : playlists.length === 0 ? (
            <div className="p-6 text-center text-muted text-sm">No recommendations available</div>
          ) : (
            <>
              <ul>
                {playlists.map(playlist => (
                  <PlaylistRow key={playlist.id} playlist={playlist} onSelect={() => handleSelectPlaylist(playlist)} />
                ))}
              </ul>
              <div className="px-4 py-2.5 border-t border-border/50 flex justify-end">
                <button onClick={refreshMfy} className="text-muted hover:text-white transition-colors" title="Shuffle">↻</button>
              </div>
            </>
          )
        ) : tab === "playlists" ? (
          loadingLibrary ? (
            <div className="h-[360px] flex items-center justify-center text-muted text-sm"><LoadingDots /></div>
          ) : !libraryPlaylists || libraryPlaylists.length === 0 ? (
            <div className="h-[360px] flex items-center justify-center text-muted text-sm">No playlists found</div>
          ) : (
            <div className="h-[360px] flex flex-col">
              <div className="px-3 py-2 border-b border-border/50 flex-shrink-0">
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
              <div ref={playlistScrollRef} className="flex-1 overflow-y-auto">
                <ul>
                  {libraryPlaylists
                    .filter(pl => pl.name.toLowerCase().includes(playlistFilter.toLowerCase()))
                    .map(pl => (
                      <PlaylistRow key={pl.id} playlist={pl} onSelect={() => handleSelectPlaylist(pl)} />
                    ))}
                </ul>
              </div>
            </div>
          )
        ) : /* related tab */ (
          relatedLoading || relatedError || relatedTracks.length === 0 ? (
            <>
              <ul>
                <TrackRowSkeleton animate={relatedLoading} />
                <TrackRowSkeleton animate={relatedLoading} />
                <TrackRowSkeleton animate={relatedLoading} />
              </ul>
              <div className="px-4 py-2.5 border-t border-border/50 flex items-center justify-between gap-3">
                {relatedLoading ? (
                  <p className="text-xs text-muted"><LoadingDots /></p>
                ) : (relatedError || relatedTracks.length === 0) ? (
                  <p className="text-xs text-muted">
                    {queue.length === 0 ? "Add tracks to the queue to get suggestions." : "None found."}
                  </p>
                ) : <span />}
                <button onClick={refreshRelated} disabled={relatedLoading} className="text-muted hover:text-white transition-colors flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed" title="Shuffle">↻</button>
              </div>
            </>
          ) : (
            <>
              <ul>
                {relatedTracks.map(track => (
                  <TrackRow
                    key={track.platformIds?.apple ?? track.isrc}
                    track={track}
                    added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                    onAdd={() => onAddTrack(track)}
                    onAlbumClick={track.platformIds?.apple ? () => handleAlbumClick(track) : undefined}
                  />
                ))}
              </ul>
              {relatedSeed && relatedPlaylist && (
                <div className="px-4 py-2.5 border-t border-border/50 flex items-start justify-between gap-3">
                  <p className="text-xs text-muted">
                    <span className="text-white/70">{relatedSeed.name}</span>
                    <span className="text-muted/60"> appears on </span>
                    <button onClick={() => handleSelectPlaylist(relatedPlaylist)} className="text-white/70 hover:text-red-400 transition-colors">{relatedPlaylist.name}</button>
                    <span className="text-muted/60"> alongside these tracks</span>
                  </p>
                  <button onClick={refreshRelated} className="text-muted hover:text-white transition-colors flex-shrink-0" title="Shuffle">↻</button>
                </div>
              )}
            </>
          )
        )}
      </div>

      <AnimatePresence>
        {modal && (
          <PlaylistModal
            playlist={modal.playlist}
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

function TrackRowSkeleton({ animate }: { animate: boolean }) {
  return (
    <li className={`flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0${animate ? " animate-pulse" : ""}`}>
      <div className="w-24 h-24 rounded flex-shrink-0 bg-surface" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-2.5 bg-surface rounded w-1/3" />
        <div className="h-4 bg-surface rounded w-3/4" />
        <div className="h-2.5 bg-surface rounded w-1/2" />
      </div>
    </li>
  )
}

function PlaylistRow({ playlist, onSelect }: {
  playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult
  onSelect: () => void
}) {
  const trackCount = 'trackCount' in playlist && playlist.trackCount != null
    ? `${playlist.trackCount} track${playlist.trackCount !== 1 ? "s" : ""}`
    : null
  const subtitle = playlist.subtitle && trackCount ? `${playlist.subtitle} — ${trackCount}`
    : playlist.subtitle || trackCount || null

  return (
    <li className="border-b border-border/50 last:border-0">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={e => e.key === "Enter" && onSelect()}
        className="flex items-center gap-3 px-4 py-3 hover:bg-surface/50 transition-colors cursor-pointer"
      >
        <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
          {playlist.artworkUrl
            ? <img src={artworkUrl(playlist.artworkUrl, 96)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-muted text-sm"><ListMusic size={14} /></div>}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-base truncate">{playlist.name}</p>
          {subtitle && <p className="text-muted text-sm truncate">{subtitle}</p>}
        </div>
        <ChevronRight size={14} className="text-muted flex-shrink-0" />
      </div>
    </li>
  )
}
