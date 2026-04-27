import { useEffect, useState, useRef } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { ChevronRight, ListMusic, X } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import { SuggestionRow } from "./SuggestionRow"
import { PlaylistModal } from "./PlaylistModal"
import { LoadingDots } from "./LoadingDots"
import type { MusicCatalog } from "../services/catalog"
import type { Track, PlaylistResult, LibraryPlaylistResult, AlbumResult, QueueItem, SearchItem, SuggestedTrack } from "../types"

type Tab = "search" | "related" | "charts" | "mfy" | "playlists" | "suggested"
type ModalState = { playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult; tracks: Track[] | null }

function pickRandom<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n)
}

interface Props {
  catalog: MusicCatalog
  queuedIsrcs: Set<string>
  suggestedIsrcs: Set<string>
  queue: QueueItem[]
  onAddTrack: (track: Track) => void
  embedded?: boolean
  suggestions: SuggestedTrack[]
  isPrivileged: boolean
  currentUserId: string
  onVoteSuggestion: (key: string) => void
  onEnqueueSuggestion?: (key: string) => void
  onRemoveSuggestion?: (key: string) => void
}

export function Discovery({ catalog, queuedIsrcs, suggestedIsrcs, queue, onAddTrack, embedded, suggestions, isPrivileged, currentUserId, onVoteSuggestion, onEnqueueSuggestion, onRemoveSuggestion }: Props) {
  const [tab, setTab] = useState<Tab>("related")

  // ── Search tab state ────────────────────────────────────────────────────────
  const [query, setQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const isSearching = query.trim().length > 0

  useEffect(() => {
    if (tab === "search") searchInputRef.current?.focus()
  }, [tab])

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

  // Auto-revert from suggested tab when suggestions list empties
  useEffect(() => {
    if (suggestions.length === 0 && tab === "suggested") setTab("related")
  }, [suggestions.length])

  const TAB_LABELS: Record<Tab, string> = {
    search: "Search",
    related: "Related",
    charts: "Top 20",
    mfy: "Top Picks",
    playlists: "Playlists",
    suggested: "Suggested",
  }

  const visibleTabs: Tab[] = suggestions.length > 0
    ? ["search", "related", "charts", "mfy", "playlists", "suggested"]
    : ["search", "related", "charts", "mfy", "playlists"]

  return (
    <>
      <div className={embedded ? "flex flex-col flex-1 min-h-0 overflow-hidden" : "bg-panel rounded-xl overflow-hidden"}>
        {!embedded && (
          <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
            Add or Request
          </div>
        )}

        {/* Tab bar */}
        <div className="border-b border-border">
          <div className="flex items-center">
            {visibleTabs.map(t => (
              <button
                key={t}
                onClick={() => handleTabChange(t)}
                className={`relative flex-1 px-1 py-3 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  tab === t ? "text-white border-accent" : "text-muted hover:text-white border-transparent"
                }`}
              >
                {t === "suggested" ? `Suggested (${suggestions.length})` : TAB_LABELS[t]}
                {t === "suggested" && tab !== "suggested" && (
                  <span className="absolute top-1.5 right-1 w-1.5 h-1.5 rounded-full bg-red-400" />
                )}
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
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search music…"
                  className="w-full bg-surface text-white placeholder-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent pr-8"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="absolute right-0 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center text-muted hover:text-white transition-colors"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            <div className={`overflow-y-auto ${embedded ? "flex-1 min-h-0" : "h-96"}`}>
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
                                added={queuedIsrcs.has(item.track.isrc) || queuedIsrcs.has(item.track.platformIds?.apple ?? "") || (!isPrivileged && (suggestedIsrcs.has(item.track.isrc) || suggestedIsrcs.has(item.track.platformIds?.apple ?? "")))}
                                onAdd={() => onAddTrack(item.track)}
                                onAlbumClick={item.track.platformIds?.apple ? () => handleAlbumClick(item.track) : undefined}
                                requestMode={!isPrivileged}
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
          <>
            <div className={`overflow-y-auto ${embedded ? "flex-1 min-h-0" : "h-[360px]"}`}>
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
                      added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "") || (!isPrivileged && (suggestedIsrcs.has(track.isrc) || suggestedIsrcs.has(track.platformIds?.apple ?? "")))}
                      onAdd={() => onAddTrack(track)}
                      onAlbumClick={track.platformIds?.apple ? () => handleAlbumClick(track) : undefined}
                      requestMode={!isPrivileged}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
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
              <div className="px-4 py-3 border-t border-border/50 flex-shrink-0">
                <button
                  onClick={refreshMfy}
                  className="w-full py-4 bg-accent hover:bg-accent-hover text-white font-bold text-base rounded-xl transition-colors tracking-wide"
                >
                  ↻ Shuffle
                </button>
              </div>
            </>
          )
        ) : tab === "playlists" ? (
          loadingLibrary ? (
            <div className={`${embedded ? "flex-1 min-h-0" : "h-[360px]"} flex items-center justify-center text-muted text-sm`}><LoadingDots /></div>
          ) : !libraryPlaylists || libraryPlaylists.length === 0 ? (
            <div className={`${embedded ? "flex-1 min-h-0" : "h-[360px]"} flex items-center justify-center text-muted text-sm`}>No playlists found</div>
          ) : (
            <div className={`${embedded ? "flex-1 min-h-0" : "h-[360px]"} flex flex-col`}>
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
                      className="absolute right-0 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-muted hover:text-white transition-colors"
                    >
                      <X size={13} />
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
        ) : tab === "suggested" ? (
          <div className={`overflow-y-auto ${embedded ? "flex-1 min-h-0" : "h-[360px]"}`}>
            {suggestions.length === 0 ? (
              <div className="p-6 text-center text-muted text-sm">No requests yet</div>
            ) : (
              <ul>
                {suggestions.map(s => (
                  <SuggestionRow
                    key={s.key}
                    suggestion={s}
                    currentUserId={currentUserId}
                    isPrivileged={isPrivileged}
                    onVote={() => onVoteSuggestion(s.key)}
                    onEnqueue={onEnqueueSuggestion ? () => onEnqueueSuggestion(s.key) : undefined}
                    onRemove={onRemoveSuggestion ? () => onRemoveSuggestion(s.key) : undefined}
                  />
                ))}
              </ul>
            )}
          </div>
        ) : /* related tab */ (
          relatedLoading || relatedError || relatedTracks.length === 0 ? (
            <>
              <ul>
                <TrackRowSkeleton animate={relatedLoading} />
                <TrackRowSkeleton animate={relatedLoading} />
                <TrackRowSkeleton animate={relatedLoading} />
              </ul>
              {(relatedError || relatedTracks.length === 0) && !relatedLoading && (
                <p className="px-4 py-3 text-xs text-muted border-t border-border/50">
                  {queue.length === 0 ? "Add tracks to the queue to get suggestions." : "None found."}
                </p>
              )}
              <div className="px-4 py-3 border-t border-border/50 flex-shrink-0">
                <button
                  onClick={refreshRelated}
                  disabled={relatedLoading}
                  className="w-full py-4 bg-accent hover:bg-accent-hover text-white font-bold text-base rounded-xl transition-colors tracking-wide disabled:opacity-30"
                >
                  {relatedLoading ? <LoadingDots /> : "↻ Refresh"}
                </button>
              </div>
            </>
          ) : (
            <>
              <ul>
                {relatedTracks.map(track => (
                  <TrackRow
                    key={track.platformIds?.apple ?? track.isrc}
                    track={track}
                    added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "") || (!isPrivileged && (suggestedIsrcs.has(track.isrc) || suggestedIsrcs.has(track.platformIds?.apple ?? "")))}
                    onAdd={() => onAddTrack(track)}
                    onAlbumClick={track.platformIds?.apple ? () => handleAlbumClick(track) : undefined}
                    requestMode={!isPrivileged}
                  />
                ))}
              </ul>
              {relatedSeed && relatedPlaylist && (
                <p className="px-4 py-3 text-xs text-muted border-t border-border/50">
                  <span className="text-white/70">{relatedSeed.name}</span>
                  <span className="text-muted/60"> appears on </span>
                  <button onClick={() => handleSelectPlaylist(relatedPlaylist)} className="text-white/70 hover:text-red-400 transition-colors">{relatedPlaylist.name}</button>
                  <span className="text-muted/60"> alongside these tracks</span>
                </p>
              )}
              <div className="px-4 py-3 border-t border-border/50 flex-shrink-0">
                <button
                  onClick={refreshRelated}
                  className="w-full py-4 bg-accent hover:bg-accent-hover text-white font-bold text-base rounded-xl transition-colors tracking-wide"
                >
                  ↻ Refresh
                </button>
              </div>
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
            ? <img src={artworkUrl(playlist.artworkUrl, 96)} alt="" loading="lazy" className="w-full h-full object-cover" />
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
