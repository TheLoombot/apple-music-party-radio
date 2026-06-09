import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { SetupScreen } from "./components/SetupScreen"
import { NowPlaying } from "./components/NowPlaying"
import { UpNext } from "./components/UpNext"
import { RobotQueue } from "./components/RobotQueue"
import { FaceGenerator } from "./components/FaceGenerator"
import { PoolModal } from "./components/PoolModal"
import { StationModal } from "./components/StationModal"
import { StationList } from "./components/StationList"
import { CommentsPanel } from "./components/CommentsPanel"
import { DiscoveryModal } from "./components/DiscoveryModal"
import { PlaylistModal } from "./components/PlaylistModal"
import { initMusicKit, authorize, isAuthorized, getMusicKit } from "./services/musickit"
import { getUserStorefront } from "./services/appleMusic"
import { getUserId, getDisplayName, setDisplayName, getOwnedStationIds, addOwnedStationId, removeOwnedStationId, getStationName, setStationName } from "./services/identity"
import { stationSocket, indexSocket } from "./services/partykit"
import { isValidFreqId, pickAvailableFreqId } from "./services/frequency"
import { PlaybackLoop } from "./services/playbackLoop"
import { AppleMusicPlayer } from "./services/appleMusicPlayer"
import { AppleMusicCatalog } from "./services/catalog"
import { log } from "./services/log"
import type { AppUser, Station, QueueItem, Track, AlbumResult, PoolTrack, Comment, Visit, SuggestedTrack } from "./types"

type AppState = "loading" | "setup" | "naming" | "auth" | "ready"

const DEV_TOKEN_SET = !!import.meta.env.VITE_APPLE_DEVELOPER_TOKEN

// Debug panel toggles persisted to localStorage so dev settings survive reloads.
// Surfaced via the small "debug" link in the footer.
interface DebugSettings { robotQueue: boolean; faceStudio: boolean }
const DEFAULT_DEBUG: DebugSettings = { robotQueue: false, faceStudio: false }
function loadDebugSettings(): DebugSettings {
  try {
    const raw = localStorage.getItem("ampr_debug")
    if (!raw) return DEFAULT_DEBUG
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_DEBUG, ...parsed }
  } catch { return DEFAULT_DEBUG }
}

export default function App() {
  const [appState, setAppState] = useState<AppState>("loading")
  const [setupError, setSetupError] = useState<string>()
  const [user, setUser] = useState<AppUser | null>(null)
  const [nameInput, setNameInput] = useState("")
  const [stations, setStations] = useState<Station[]>([])
  const [currentStationId, setCurrentStationId] = useState("")
  const [stationSelected, setStationSelected] = useState(() => isValidFreqId(window.location.pathname.slice(import.meta.env.BASE_URL.length)))
  const [nowPlaying, setNowPlaying] = useState<QueueItem | null>(null)
  const [upNext, setUpNext] = useState<QueueItem[]>([])
  const [pool, setPool] = useState<PoolTrack[]>([])
  const [poolModalOpen, setPoolModalOpen] = useState(false)
  const [stationModalOpen, setStationModalOpen] = useState(false)
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false)
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState(false)
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches)
  const [comments, setComments] = useState<Comment[]>([])
  const [visits, setVisits] = useState<Visit[]>([])
  const [isMuted, setIsMuted] = useState(false)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [previewOnly, setPreviewOnly] = useState(false)
  const [ownedStationIds, setOwnedStationIds] = useState<string[]>(() => getOwnedStationIds())
  const [djUserIds, setDJUserIds] = useState<string[]>([])
  const [serverConnected, setServerConnected] = useState<boolean | null>(null)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newStationName, setNewStationName] = useState("")
  const [createError, setCreateError] = useState<"" | "band-full" | "slot-taken" | "error">("")
  const [isCreatingStation, setIsCreatingStation] = useState(false)
  const [previewFrequency, setPreviewFrequency] = useState<string | null>(null)
  const [renamingDJ, setRenamingDJ] = useState(false)
  const [renameInput, setRenameInput] = useState("")
  const [queueFullAlert, setQueueFullAlert] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestedTrack[]>([])
  const [suggestionsFullAlert, setSuggestionsFullAlert] = useState<number | null>(null)
  const [djNotes, setDjNotes] = useState<Record<string, string>>({})
  const [albumModal, setAlbumModal] = useState<{ playlist: AlbumResult; tracks: Track[] | null } | null>(null)
  // True between entering a station and receiving its first queue snapshot from the server.
  // Lets NowPlaying distinguish "tuning in" from "confirmed empty queue".
  const [stationLoading, setStationLoading] = useState<boolean>(() => isValidFreqId(window.location.pathname.slice(import.meta.env.BASE_URL.length)))
  const [easterEggOpen, setEasterEggOpen] = useState(false)
  const [debugMenuOpen, setDebugMenuOpen] = useState(false)
  const [debugSettings, setDebugSettings] = useState<DebugSettings>(loadDebugSettings)
  const toggleDebug = useCallback((key: keyof DebugSettings) => {
    setDebugSettings(prev => {
      const next = { ...prev, [key]: !prev[key] }
      try { localStorage.setItem("ampr_debug", JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])
  const renameRef = useRef<HTMLInputElement>(null)
  const albumModalOpRef = useRef(0)
  const playbackLoop = useRef(new PlaybackLoop(new AppleMusicPlayer()))
  const catalog = useRef(new AppleMusicCatalog("us"))

  // Pick the preview frequency once when the modal opens and hold it. The
  // server will require this exact freq at creation time; if it got taken
  // in the meantime the create call fails with slot-taken.
  useEffect(() => {
    if (!createModalOpen) { setPreviewFrequency(null); return }
    const taken = new Set(stations.map(s => s.id))
    setPreviewFrequency(pickAvailableFreqId(taken))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createModalOpen])

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])

  // Boot: check config, init MusicKit
  useEffect(() => {
    if (!DEV_TOKEN_SET) {
      setSetupError("VITE_APPLE_DEVELOPER_TOKEN is not set. Run: npm run generate-token")
      setAppState("setup")
      return
    }

    initMusicKit()
      .then(async () => {
        if (!getDisplayName()) {
          setAppState("naming")
          return
        }
        if (isAuthorized()) {
          log.auth.info("session restored, completing auth silently")
          await completeAuth()
        } else {
          setAppState("auth")
        }
      })
      .catch((err: Error) => {
        setSetupError(err.message)
        setAppState("setup")
      })
  }, [])

  // Once ready, wire up PartyKit
  useEffect(() => {
    if (appState !== "ready" || !user) return
    let didSetInitialStation = false
    indexSocket.onConnectionChange = setServerConnected
    indexSocket.onStationsUpdate = (newStations) => {
      setStations(newStations)
      // On first update, auto-select only if a valid frequency is in the URL
      if (!didSetInitialStation) {
        didSetInitialStation = true
        const pathStation = window.location.pathname.slice(import.meta.env.BASE_URL.length)
        if (pathStation && isValidFreqId(pathStation)) setCurrentStationId(pathStation)
      }
    }
    indexSocket.connect()
    // Sweep legacy slug-shaped ids out of localStorage (pre-frequency-id model).
    // Anything that isn't a valid FM frequency is dropped silently.
    const owned = getOwnedStationIds()
    for (const stationId of owned) {
      if (!isValidFreqId(stationId)) {
        removeOwnedStationId(stationId)
        continue
      }
      indexSocket.register(stationId, getStationName(stationId), user.storefront, user.uid, parseFloat(stationId), user.displayName)
    }
    setOwnedStationIds(getOwnedStationIds())

    // Sync path → station on browser back/forward
    const onPopState = () => {
      const stationId = window.location.pathname.slice(import.meta.env.BASE_URL.length)
      if (stationId && isValidFreqId(stationId)) {
        setNowPlaying(null)
        setUpNext([])
        setStationLoading(true)
        setPlaybackBlocked(false)
        setComments([])
        setVisits([])
        playbackLoop.current.enableAutoplay()
        setStationSelected(true)
        setCurrentStationId(stationId)
      } else {
        playbackLoop.current.stop()
        setNowPlaying(null)
        setUpNext([])
        setStationLoading(false)
        setPlaybackBlocked(false)
        setComments([])
        setVisits([])
        setSuggestions([])
        setCurrentStationId("")
        setStationSelected(false)
      }
    }
    window.addEventListener("popstate", onPopState)

    return () => {
      indexSocket.disconnect()
      window.removeEventListener("popstate", onPopState)
    }
  }, [appState, user])

  // Update page title to current station name
  useEffect(() => {
    const name = stations.find(s => s.id === currentStationId)?.displayName || currentStationId
    document.title = name ? `${name} — Party Radio` : "Apple Music Party Radio"
  }, [currentStationId, stations])

  // Start playback loop when station changes
  useEffect(() => {
    if (appState !== "ready" || !currentStationId || !user) return
    playbackLoop.current.onNowPlayingChange = (item) => { setStationLoading(false); setNowPlaying(item) }
    playbackLoop.current.onPreviewOnly = () => setPreviewOnly(true)
    playbackLoop.current.onQueueChange = (upNext) => { setStationLoading(false); setUpNext(upNext) }
    playbackLoop.current.onPlaybackBlocked = () => setPlaybackBlocked(true)
    playbackLoop.current.onMutedChange = setIsMuted
    stationSocket.onPoolUpdate = setPool
    stationSocket.onCommentsUpdate = setComments
    stationSocket.onVisitsUpdate = setVisits
    stationSocket.onDJUpdate = setDJUserIds
    stationSocket.onQueueFull = (limit) => setQueueFullAlert(limit)
    stationSocket.onSuggestionsUpdate = setSuggestions
    stationSocket.onSuggestionsFull = (limit) => setSuggestionsFullAlert(limit)
    stationSocket.onDJNotesUpdate = setDjNotes
    setDJUserIds([])
    setSuggestions([])
    setDjNotes({})
    playbackLoop.current.start(currentStationId)
    stationSocket.join(user.uid, user.displayName)
    return () => playbackLoop.current.stop()
  }, [currentStationId, appState, user?.uid]) // user.uid is stable; display name changes handled below

  // Re-send join when display name changes — no reconnect needed
  useEffect(() => {
    if (appState !== "ready" || !currentStationId || !user) return
    stationSocket.join(user.uid, user.displayName)
  }, [user?.displayName]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleSaveName = () => {
    const name = nameInput.trim() || `DJ ${getUserId().slice(0, 6)}`
    setDisplayName(name)
    setAppState("auth")
  }

  const completeAuth = async () => {
    await authorize()
    const storefront = await getUserStorefront()
    const uid = getUserId()
    const displayName = getDisplayName() ?? `DJ ${uid.slice(0, 6)}`
    catalog.current = new AppleMusicCatalog(storefront)
    setUser({ uid, storefront, displayName })
    setAppState("ready")
  }

  const handleAuthorize = useCallback(async () => {
    try {
      await completeAuth()
    } catch (err: any) {
      setSetupError(err.message)
      setAppState("setup")
    }
  }, [])

  const handleAddTrack = useCallback((track: Track) => {
    if (!user) return
    if (!track.platformIds?.apple) return
    const fullQueue = [...(nowPlaying ? [nowPlaying] : []), ...upNext]
    // Only treat user-spun queue entries as "already added" — clicking + on
    // a robot-queued track should promote it via addTrack (server moves it
    // from robot tail to user tail), not remove it.
    const existing = fullQueue.find(i =>
      i.addedBy !== "robot" &&
      ((track.isrc && i.isrc === track.isrc) ||
       (track.platformIds?.apple && i.platformIds?.apple === track.platformIds.apple))
    )
    if (existing) {
      stationSocket.removeTrack(existing.key)
    } else {
      stationSocket.addTrack(track, user.uid)
    }
  }, [user, nowPlaying, upNext])

  const handleRemoveTrack = useCallback((item: QueueItem) => {
    stationSocket.removeTrack(item.key)
  }, [])

  const handleRemoveFromPool = useCallback((isrc: string) => {
    stationSocket.removeFromPool(isrc)
  }, [])

  const handleClearPool = useCallback(() => {
    stationSocket.clearPool()
  }, [])

  const handleSkip = useCallback(() => {
    stationSocket.skipTrack()
  }, [])

  const handleSkipAndBan = useCallback(() => {
    stationSocket.skipAndRemoveFromPool()
  }, [])

  const handleSuggestTrack = useCallback((track: Track) => {
    if (!user || !track.platformIds?.apple) return
    stationSocket.suggestTrack(track)
  }, [user])

  const handleVoteSuggestion = useCallback((key: string) => {
    stationSocket.voteSuggestion(key)
  }, [])

  const handleEnqueueSuggestion = useCallback((key: string) => {
    stationSocket.enqueueSuggestion(key)
  }, [])

  const handleRemoveSuggestion = useCallback((key: string) => {
    stationSocket.removeSuggestion(key)
  }, [])

  const handleMuteToggle = useCallback(() => {
    playbackLoop.current.setMuted(!isMuted)
  }, [isMuted])

  const handleReauthorize = useCallback(async () => {
    try {
      // Unauthorize first so MusicKit doesn't skip the popup when already authorized
      await getMusicKit().unauthorize()
      await authorize()
      await playbackLoop.current.refresh()
    } catch (err: any) {
      log.auth.error("reauth failed:", err)
    }
  }, [])

  const handleResume = useCallback(async () => {
    setPlaybackBlocked(false)
    await playbackLoop.current.resume()
  }, [])

  const handleStartRename = useCallback(() => {
    if (!user) return
    setRenameInput(user.displayName)
    setRenamingDJ(true)
    setTimeout(() => renameRef.current?.select(), 0)
  }, [user])

  const handleCommitRename = useCallback(() => {
    if (!user) return
    const name = renameInput.trim() || user.displayName
    setDisplayName(name)
    setUser(prev => prev ? { ...prev, displayName: name } : prev)
    // Re-register owned stations using their own stored names (not the DJ name)
    for (const stationId of getOwnedStationIds()) {
      indexSocket.register(stationId, getStationName(stationId), user.storefront, user.uid, undefined, name)
    }
    setRenamingDJ(false)
  }, [user, renameInput])

  const handleRenameStation = useCallback((newName: string, newFreq: number) => {
    if (!user || !currentStationId) return
    const name = newName.trim() || currentStationId
    setStationName(currentStationId, name)
    indexSocket.register(currentStationId, name, user.storefront, user.uid, newFreq, user.displayName)
  }, [user, currentStationId])

  const handleSelectStation = useCallback((stationId: string) => {
    if (stationId === currentStationId) return
    log.app.info("select station", { from: currentStationId || null, to: stationId })
    window.history.pushState(null, "", `${import.meta.env.BASE_URL}${stationId}`)
    setNowPlaying(null)
    setUpNext([])
    setStationLoading(true)
    setPlaybackBlocked(false)
    setComments([])
    setVisits([])
    setSuggestions([])
    playbackLoop.current.enableAutoplay()
    setStationSelected(true)
    setCurrentStationId(stationId)
  }, [currentStationId])

  const handleRemoveStation = useCallback((stationId: string) => {
    if (!user) return
    log.app.info("remove station", { stationId })
    indexSocket.removeStation(stationId, user.uid)
    removeOwnedStationId(stationId)
    setOwnedStationIds(getOwnedStationIds())
    if (stationId === currentStationId) {
      const nextStation = stations.find(s => s.id !== stationId && s.liveUntil > Date.now())
      handleSelectStation(nextStation?.id ?? stations.find(s => s.id !== stationId)?.id ?? "")
    }
  }, [currentStationId, stations, user])

  const handleCreateStation = useCallback(async () => {
    if (!user) return
    const name = newStationName.trim()
    if (!name) return
    setIsCreatingStation(true)
    setCreateError("")
    const result = await indexSocket.createStation(user.uid, name, user.storefront, previewFrequency ?? undefined)
    if (!result.ok) {
      setCreateError(result.reason)
      if (result.reason === "slot-taken") {
        setPreviewFrequency(pickAvailableFreqId(new Set(stations.map(s => s.id))))
      }
      setIsCreatingStation(false)
      return
    }
    const freq = result.frequency
    log.app.info("create station", { freq, name })
    setStationName(freq, name)
    addOwnedStationId(freq)
    setOwnedStationIds(getOwnedStationIds())
    indexSocket.register(freq, name, user.storefront, user.uid, parseFloat(freq), user.displayName)
    setCreateModalOpen(false)
    setStationModalOpen(false)
    setNewStationName("")
    setCreateError("")
    setIsCreatingStation(false)
    handleSelectStation(freq)
  }, [user, newStationName, previewFrequency])

  const handleSaveDjNote = useCallback((itemId: string, note: string) => {
    stationSocket.setDjNote(itemId, note)
  }, [])

  const handleAlbumClick = useCallback(async (songId: string) => {
    const op = ++albumModalOpRef.current
    const placeholder: AlbumResult = { kind: "album", id: "_loading", name: "", subtitle: "", artworkUrl: "" }
    setAlbumModal({ playlist: placeholder, tracks: null })
    const album = await catalog.current.getAlbumForTrack(songId)
    if (albumModalOpRef.current !== op) return
    if (!album) { setAlbumModal(null); return }
    setAlbumModal({ playlist: album, tracks: null })
    const tracks = await catalog.current.getAlbumTracks(album.id)
    if (albumModalOpRef.current === op) setAlbumModal({ playlist: album, tracks })
  }, [])

  // ─── Render ───────────────────────────────────────────────────────────────

  // Derived state — must be before any early returns to satisfy Rules of Hooks
  const queuedIsrcs = useMemo(() => new Set(
    [...(nowPlaying ? [nowPlaying] : []), ...upNext]
      .flatMap(i => [i.isrc, i.platformIds?.apple])
      .filter(Boolean) as string[]
  ), [nowPlaying, upNext])
  /** Subset of queuedIsrcs for tracks added by a human (not the robot DJ).
   *  Used to drive the "check / already queued" indicator in pickers — robot
   *  tracks deliberately show as addable so a DJ can claim/promote them. */
  const userQueuedIds = useMemo(() => new Set(
    [...(nowPlaying && nowPlaying.addedBy !== "robot" ? [nowPlaying] : []),
     ...upNext.filter(i => i.addedBy !== "robot")]
      .flatMap(i => [i.isrc, i.platformIds?.apple])
      .filter(Boolean) as string[]
  ), [nowPlaying, upNext])
  /** Identifiers of the currently-playing track. Components rendering pickers
   *  (Discovery/Pool/Playlist) use this to mark a row as "now playing" and
   *  disable add/remove operations on it. */
  const nowPlayingIds = useMemo(() => new Set(
    nowPlaying ? [nowPlaying.isrc, nowPlaying.platformIds?.apple].filter(Boolean) as string[] : []
  ), [nowPlaying])
  const suggestedIsrcs = useMemo(() => new Set(
    suggestions.flatMap(s => [s.isrc, s.platformIds?.apple].filter(Boolean) as string[])
  ), [suggestions])
  const userQueue = useMemo(() => upNext.filter(item => item.addedBy !== "robot"), [upNext])
  const robotQueue = useMemo(() => upNext.filter(item => item.addedBy === "robot"), [upNext])
  // Listener count for the chat button. Shown only when >1 (i.e. someone
  // besides the current user is listening) by the button itself.
  const listenerCount = stations.find(s => s.id === currentStationId)?.listeners?.length ?? 0
  const activeStationCount = useMemo(
    () => stations.filter(s => s.liveUntil > Date.now() && s.id !== currentStationId).length,
    [stations, currentStationId]
  )
  const liveStations = useMemo(
    () => stations.filter(s => s.liveUntil > Date.now()).sort((a, b) => (a.frequency ?? 0) - (b.frequency ?? 0)),
    [stations]
  )
  const currentLiveIdx = liveStations.findIndex(s => s.id === currentStationId)
  const handlePrevStation = useCallback(() => {
    if (liveStations.length <= 1) return
    const idx = currentLiveIdx <= 0 ? liveStations.length - 1 : currentLiveIdx - 1
    handleSelectStation(liveStations[idx].id)
  }, [liveStations, currentLiveIdx, handleSelectStation])
  const handleNextStation = useCallback(() => {
    if (liveStations.length <= 1) return
    const idx = currentLiveIdx >= liveStations.length - 1 ? 0 : currentLiveIdx + 1
    handleSelectStation(liveStations[idx].id)
  }, [liveStations, currentLiveIdx, handleSelectStation])
  const nowPlayingIsInPool = useMemo(() => {
    if (!nowPlaying) return false
    return pool.some(p => {
      if (nowPlaying.isrc && p.isrc) return nowPlaying.isrc === p.isrc
      if (nowPlaying.platformIds?.apple && p.platformIds?.apple) return nowPlaying.platformIds.apple === p.platformIds.apple
      if (nowPlaying.platformIds?.spotify && p.platformIds?.spotify) return nowPlaying.platformIds.spotify === p.platformIds.spotify
      return false
    })
  }, [nowPlaying, pool])

  // Diagnostic: presence collapsed to empty for the station we're on while
  // we're still connected to the index. Pairs with the server-side
  // [presence] hibernation desync warning. Lives above early returns to
  // satisfy Rules of Hooks.
  const currentListenerCount = stations.find(s => s.id === currentStationId)?.listeners?.length ?? 0
  const prevListenerCountRef = useRef<number | null>(null)
  useEffect(() => {
    const prev = prevListenerCountRef.current
    if (prev != null && prev > 0 && currentListenerCount === 0 && serverConnected) {
      log.app.warn("listeners panel collapsed to empty while connected", {
        stationId: currentStationId, previousCount: prev,
      })
    }
    prevListenerCountRef.current = currentListenerCount
  }, [currentListenerCount, currentStationId, serverConnected])

  if (appState === "setup") return <SetupScreen error={setupError} />

  if (appState === "loading") {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-muted text-sm animate-pulse">Starting up…</p>
      </div>
    )
  }

  if (appState === "naming") {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-8">
        <div className="max-w-sm w-full bg-panel rounded-2xl p-8 text-center">
          <div className="text-5xl mb-4">🎙</div>
          <h1 className="text-xl font-bold text-white mb-2">What's your DJ name?</h1>
          <p className="text-muted text-sm mb-6">This is how your station will appear to listeners.</p>
          <input
            autoFocus
            type="text"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSaveName()}
            placeholder={`DJ ${getUserId().slice(0, 6)}`}
            className="w-full bg-surface text-white placeholder-muted rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-accent mb-4"
          />
          <button
            onClick={handleSaveName}
            className="w-full bg-accent hover:bg-accent-hover text-white font-semibold py-3 rounded-xl transition-colors"
          >
            Let's go
          </button>
        </div>
      </div>
    )
  }

  if (appState === "auth") {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-8">
        <div className="max-w-sm w-full bg-panel rounded-2xl p-8 text-center">
          <div className="text-5xl mb-4">🎵</div>
          <h1 className="text-xl font-bold text-white mb-2">Apple Music Party Radio</h1>
          <p className="text-muted text-sm mb-6">
            Connect your Apple Music account to start broadcasting or tune into a station.
          </p>
          <button
            onClick={handleAuthorize}
            className="w-full bg-accent hover:bg-accent-hover text-white font-semibold py-3 rounded-xl transition-colors"
          >
            Connect Apple Music
          </button>
        </div>
      </div>
    )
  }

  if (!user) return null

  const isOwnStation = ownedStationIds.includes(currentStationId)
    || stations.find(s => s.id === currentStationId)?.ownerUid === user.uid
  const isPrivileged = isOwnStation || djUserIds.includes(user.uid)
  const currentStation = stations.find(s => s.id === currentStationId)
  const stationOwnerName = (() => {
    if (!currentStation?.ownerUid) return undefined
    if (currentStation.ownerUid === user.uid) return "You"
    return currentStation.ownerDisplayName
      ?? currentStation.listeners?.find(l => l.userId === currentStation.ownerUid)?.displayName
      ?? "Unknown"
  })()

  return (
    <div className="min-h-screen bg-surface flex flex-col">

      {serverConnected === false && stations.length === 0 && (
        <div className="bg-red-900/40 border-b border-red-700/40 px-6 py-2 text-xs text-red-300 flex items-center gap-2">
          <span>⚠️</span>
          <span>Cannot connect to the Party Radio server — stations and playback sync are unavailable. Is the PartyKit server running?</span>
        </div>
      )}

      {previewOnly && (
        <div className="bg-yellow-900/40 border-b border-yellow-700/40 px-6 py-2 text-xs text-yellow-300 flex items-center gap-2">
          <span>⚠️</span>
          <span>
            Preview-only playback detected — your browser (Chrome) doesn't support Apple's FairPlay DRM.
            Full songs play in Safari. Playback on this station will be limited to 30-second previews.
          </span>
        </div>
      )}

      {queueFullAlert !== null && (
        <div className="bg-orange-900/50 border-b border-orange-700/40 px-6 py-2 text-xs text-orange-200 flex items-center justify-between gap-2">
          <span>You already have {queueFullAlert} songs queued — remove one before adding more.</span>
          <button onClick={() => setQueueFullAlert(null)} className="text-orange-300 hover:text-white transition-colors ml-4 shrink-0">✕</button>
        </div>
      )}

      {suggestionsFullAlert !== null && (
        <div className="bg-orange-900/50 border-b border-orange-700/40 px-6 py-2 text-xs text-orange-200 flex items-center justify-between gap-2">
          <span>The request list is full ({suggestionsFullAlert} max) — a DJ needs to review some before more can be added.</span>
          <button onClick={() => setSuggestionsFullAlert(null)} className="text-orange-300 hover:text-white transition-colors ml-4 shrink-0">✕</button>
        </div>
      )}

      <AnimatePresence>
        {albumModal && (
          <PlaylistModal
            playlist={albumModal.playlist}
            tracks={albumModal.tracks}
            queuedIsrcs={userQueuedIds}
            nowPlayingIds={nowPlayingIds}
            onAddTrack={handleAddTrack}
            onClose={() => { albumModalOpRef.current++; setAlbumModal(null) }}
            catalog={catalog.current}
            djNotes={djNotes}
            onSaveDjNote={isPrivileged ? handleSaveDjNote : undefined}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {poolModalOpen && (
          <PoolModal
            pool={pool}
            currentUser={user}
            canManagePool={isPrivileged}
            canClearPool={isOwnStation}
            queuedIsrcs={userQueuedIds}
            nowPlayingIds={nowPlayingIds}
            onAddTrack={handleAddTrack}
            onRemoveFromPool={handleRemoveFromPool}
            onClearPool={handleClearPool}
            onClose={() => setPoolModalOpen(false)}
            catalog={catalog.current}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {stationModalOpen && (
          <StationModal
            onClose={() => setStationModalOpen(false)}
            stations={stations}
            currentStationId={currentStationId}
            userId={user.uid}
            userDisplayName={user.displayName}
            ownedStationIds={ownedStationIds}
            onSelect={(id) => { handleSelectStation(id); setStationModalOpen(false) }}
            onRemove={handleRemoveStation}
            onCreateStation={() => setCreateModalOpen(true)}
          />
        )}
      </AnimatePresence>

      {createModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80" onClick={() => setCreateModalOpen(false)}>
          <div className="bg-panel rounded-2xl p-8 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            {previewFrequency && (
              <p
                className="text-amber-400 text-2xl font-press-start text-center mb-6"
                style={{ textShadow: "0 0 8px rgba(255, 152, 0, 0.85), 0 0 18px rgba(255, 152, 0, 0.55)" }}
              >
                {previewFrequency} FM
              </p>
            )}
            <input
              autoFocus
              type="text"
              value={newStationName}
              onChange={e => { setNewStationName(e.target.value.slice(0, 40)); setCreateError("") }}
              onKeyDown={e => { if (e.key === "Enter") handleCreateStation(); if (e.key === "Escape") setCreateModalOpen(false) }}
              placeholder="Station Name"
              className="w-full bg-surface text-white placeholder-muted rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-accent mb-6"
            />
            {createError && (
              <p className="text-red-400 text-xs mb-4">
                {createError === "band-full"
                  ? "The FM band is full — no frequencies available."
                  : createError === "slot-taken"
                  ? "Someone just grabbed that frequency. Try again."
                  : "Couldn't create station. Try again."}
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setCreateModalOpen(false)}
                className="flex-1 py-3 rounded-xl bg-surface text-muted font-semibold text-sm transition-colors hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateStation}
                disabled={!newStationName.trim() || isCreatingStation}
                className="flex-1 py-3 rounded-xl bg-accent hover:bg-accent-hover text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isCreatingStation ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {commentsPanelOpen && !isDesktop && (
          <CommentsPanel
            onClose={() => setCommentsPanelOpen(false)}
            listeners={currentStation?.listeners ?? []}
            comments={comments}
            visits={visits}
            currentUser={user}
            ownerUid={currentStation?.ownerUid}
            djUserIds={djUserIds}
            isStationOwner={isOwnStation}
            onPostComment={(text) => stationSocket.postComment(text)}
            onGrantDJ={(uid) => stationSocket.grantDJ(uid)}
            onRevokeDJ={(uid) => stationSocket.revokeDJ(uid)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {discoveryModalOpen && !isDesktop && (
          <DiscoveryModal
            onClose={() => setDiscoveryModalOpen(false)}
            catalog={catalog.current}
            queuedIsrcs={queuedIsrcs}
            userQueuedIds={userQueuedIds}
            nowPlayingIds={nowPlayingIds}
            suggestedIsrcs={suggestedIsrcs}
            queue={[...(nowPlaying ? [nowPlaying] : []), ...upNext]}
            onAddTrack={isPrivileged ? handleAddTrack : handleSuggestTrack}
            suggestions={suggestions}
            isPrivileged={isPrivileged}
            currentUserId={user.uid}
            onVoteSuggestion={handleVoteSuggestion}
            onEnqueueSuggestion={isPrivileged ? handleEnqueueSuggestion : undefined}
            onRemoveSuggestion={isPrivileged ? handleRemoveSuggestion : undefined}
          />
        )}
      </AnimatePresence>

      {/* Main layout — single centered column */}
      {!stationSelected ? (
        <div className="flex-1 max-w-[480px] w-full mx-auto px-4 py-6 space-y-4">
          <div className="bg-panel rounded-xl overflow-hidden">
            <StationList
              stations={stations}
              currentStationId={currentStationId}
              userId={user.uid}
              userDisplayName={user.displayName}
              ownedStationIds={ownedStationIds}
              onSelect={handleSelectStation}
              onRemove={handleRemoveStation}
              onCreateStation={() => setCreateModalOpen(true)}
            />
          </div>
        </div>
      ) : (
      <div className="flex-1 flex items-start justify-center py-4 gap-3">

        {/* Add/Request side panel — desktop left */}
        <AnimatePresence>
          {discoveryModalOpen && isDesktop && (
            <DiscoveryModal
              mode="panel"
              onClose={() => setDiscoveryModalOpen(false)}
              catalog={catalog.current}
              queuedIsrcs={queuedIsrcs}
              userQueuedIds={userQueuedIds}
              nowPlayingIds={nowPlayingIds}
              suggestedIsrcs={suggestedIsrcs}
              queue={[...(nowPlaying ? [nowPlaying] : []), ...upNext]}
              onAddTrack={isPrivileged ? handleAddTrack : handleSuggestTrack}
              suggestions={suggestions}
              isPrivileged={isPrivileged}
              currentUserId={user.uid}
              onVoteSuggestion={handleVoteSuggestion}
              onEnqueueSuggestion={isPrivileged ? handleEnqueueSuggestion : undefined}
              onRemoveSuggestion={isPrivileged ? handleRemoveSuggestion : undefined}
            />
          )}
        </AnimatePresence>

        <div className="w-full max-w-[480px] px-4 space-y-4 flex-shrink-0 min-w-0">

        <NowPlaying
          track={nowPlaying}
          stationOwner={currentStationId}
          currentUser={user}
          canSkip={isPrivileged}
          onSkip={handleSkip}
          onSkipAndBan={isPrivileged && nowPlayingIsInPool ? handleSkipAndBan : undefined}
          isMuted={isMuted}
          onMuteToggle={handleMuteToggle}
          isBlocked={playbackBlocked}
          onResume={handleResume}
          onAlbumClick={isPrivileged && nowPlaying?.platformIds?.apple ? () => handleAlbumClick(nowPlaying.platformIds!.apple!) : undefined}
          onOpenPool={isPrivileged ? () => setPoolModalOpen(true) : undefined}
          catalog={catalog.current}
          stationName={stations.find(s => s.id === currentStationId)?.displayName || currentStationId}
          isOwner={isOwnStation}
          ownerName={stationOwnerName}
          onRenameStation={isOwnStation ? handleRenameStation : undefined}
          onOpenStationModal={() => setStationModalOpen(true)}
          activeStationCount={activeStationCount}
          frequency={stations.find(s => s.id === currentStationId)?.frequency}
          onPrevStation={liveStations.length > 1 ? handlePrevStation : undefined}
          onNextStation={liveStations.length > 1 ? handleNextStation : undefined}
          loading={stationLoading}
          onOpenChat={() => setCommentsPanelOpen(v => !v)}
          chatPanelOpen={commentsPanelOpen}
          unreadCount={listenerCount}
          onOpenAddTracks={() => setDiscoveryModalOpen(v => !v)}
          addTracksPanelOpen={discoveryModalOpen}
          addButtonLabel={isPrivileged
            ? suggestions.length > 0
              ? `Add tracks (${suggestions.length} ${suggestions.length === 1 ? "request" : "requests"})`
              : "Add tracks"
            : "Request a track"}
          addBadgeCount={isPrivileged ? suggestions.length : 0}
          djNotes={djNotes}
          onSaveDjNote={isPrivileged ? handleSaveDjNote : undefined}
        />

        <UpNext
          queue={userQueue}
          currentUser={user}
          stationOwner={currentStationId}
          onRemove={handleRemoveTrack}
          onReorder={isPrivileged ? (keys) => stationSocket.reorderQueue(keys) : undefined}
          onAlbumClick={isPrivileged ? (item) => { if (item.platformIds?.apple) handleAlbumClick(item.platformIds.apple) } : undefined}
        />

        {debugSettings.robotQueue && (
          <RobotQueue
            queue={robotQueue}
            onRemove={isPrivileged ? handleRemoveTrack : undefined}
            onAlbumClick={isPrivileged ? (item) => { if (item.platformIds?.apple) handleAlbumClick(item.platformIds.apple) } : undefined}
          />
        )}

        </div>{/* end main content column */}

        {/* Comments side panel — desktop right (combined listeners + comments) */}
        <AnimatePresence>
          {commentsPanelOpen && isDesktop && (
            <CommentsPanel
              mode="panel"
              onClose={() => setCommentsPanelOpen(false)}
              listeners={currentStation?.listeners ?? []}
              comments={comments}
              visits={visits}
              currentUser={user}
              ownerUid={currentStation?.ownerUid}
              djUserIds={djUserIds}
              isStationOwner={isOwnStation}
              onPostComment={(text) => stationSocket.postComment(text)}
              onGrantDJ={(uid) => stationSocket.grantDJ(uid)}
              onRevokeDJ={(uid) => stationSocket.revokeDJ(uid)}
            />
          )}
        </AnimatePresence>

      </div>
      )}

      {/* Footer */}
      <footer className="border-t border-border/50 max-w-[480px] w-full mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted/40">
          <button
            onClick={() => setEasterEggOpen(true)}
            className="hover:scale-125 transition-transform"
            aria-label="🎵"
          >🎵</button>
          <button
            onClick={() => {
              window.history.pushState(null, "", import.meta.env.BASE_URL || "/")
              window.dispatchEvent(new PopStateEvent("popstate"))
            }}
            className="hover:text-white transition-colors"
          >Party Radio</button>
          <span className="font-mono text-muted/25">{__COMMIT__}</span>
          <button
            onClick={() => setDebugMenuOpen(v => !v)}
            className="font-mono text-muted/25 hover:text-white/70 transition-colors"
            title="Debug panels"
          >debug</button>
          <a
            href="https://github.com/theloombot/apple-music-party-radio"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white/70 transition-colors"
            aria-label="GitHub repository"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
            </svg>
          </a>
        </div>
        <div className="text-xs">
          {renamingDJ ? (
            <input
              ref={renameRef}
              value={renameInput}
              onChange={e => setRenameInput(e.target.value)}
              onBlur={handleCommitRename}
              onKeyDown={e => { if (e.key === "Enter") handleCommitRename(); if (e.key === "Escape") setRenamingDJ(false) }}
              className="bg-surface text-white rounded px-2 py-0.5 text-xs outline-none focus:ring-1 focus:ring-accent w-36"
            />
          ) : (
            <button
              onClick={handleStartRename}
              className="text-muted/60 hover:text-white transition-colors"
              title="Click to rename"
            >
              DJ <span className="text-white/60 hover:text-white">{user.displayName}</span>
            </button>
          )}
        </div>
      </footer>

      {/* Debug menu — small popover anchored at the footer "debug" link.
       *  Click outside (the backdrop) to dismiss. Each toggle persists. */}
      <AnimatePresence>
        {debugMenuOpen && (
          <motion.div
            className="fixed inset-0 z-[70] flex items-end justify-start p-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={() => setDebugMenuOpen(false)}
          >
            <motion.div
              className="bg-panel border border-border rounded-xl shadow-2xl p-3 min-w-[200px]"
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 10, opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={e => e.stopPropagation()}
            >
              <p className="text-muted/60 text-[10px] uppercase tracking-widest mb-2">Debug panels</p>
              <label className="flex items-center gap-2 py-1.5 text-sm text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={debugSettings.robotQueue}
                  onChange={() => toggleDebug("robotQueue")}
                />
                Robot queue
              </label>
              <label className="flex items-center gap-2 py-1.5 text-sm text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={debugSettings.faceStudio}
                  onChange={() => toggleDebug("faceStudio")}
                />
                Face studio
              </label>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Face studio — debug tool to inspect / iterate on the avatar generator. */}
      <AnimatePresence>
        {debugSettings.faceStudio && (
          <motion.div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => toggleDebug("faceStudio")}
          >
            <motion.div
              className="w-full max-w-md max-h-[90vh] overflow-y-auto"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={e => e.stopPropagation()}
            >
              <FaceGenerator />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Easter egg — tap the 🎵 in the footer */}
      <AnimatePresence>
        {easterEggOpen && (
          <motion.div
            className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/80 cursor-pointer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setEasterEggOpen(false)}
          >
            <motion.img
              src={`${import.meta.env.BASE_URL}hatfm-easter-egg.png`}
              alt=""
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={e => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  )
}
