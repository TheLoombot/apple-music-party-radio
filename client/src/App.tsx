import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { SetupScreen } from "./components/SetupScreen"
import { NowPlaying } from "./components/NowPlaying"
import { UpNext } from "./components/UpNext"
import { RobotQueue } from "./components/RobotQueue"
import { PoolModal } from "./components/PoolModal"
import { StationModal } from "./components/StationModal"
import { StationList } from "./components/StationList"
import { ChatModal } from "./components/ChatModal"
import { DiscoveryModal } from "./components/DiscoveryModal"
import { ListenersPanel } from "./components/ListenersPanel"
import { PlaylistModal } from "./components/PlaylistModal"
import { initMusicKit, authorize, isAuthorized, getMusicKit } from "./services/musickit"
import { getUserStorefront } from "./services/appleMusic"
import { getUserId, getDisplayName, setDisplayName, getOwnedStationIds, addOwnedStationId, removeOwnedStationId, getStationName, setStationName } from "./services/identity"
import { stationSocket, indexSocket } from "./services/partykit"
import { isValidFreqId, pickAvailableFreqId } from "./services/frequency"
import { PlaybackLoop } from "./services/playbackLoop"
import { AppleMusicPlayer } from "./services/appleMusicPlayer"
import { AppleMusicCatalog } from "./services/catalog"
import type { AppUser, Station, QueueItem, Track, AlbumResult, PoolTrack, ChatMessage, SuggestedTrack } from "./types"

type AppState = "loading" | "setup" | "naming" | "auth" | "ready"

const DEV_TOKEN_SET = !!import.meta.env.VITE_APPLE_DEVELOPER_TOKEN

// Feature flag — flip back to `true` to surface the robot queue panel again.
// Server still fills the queue from the pool; this only controls the UI panel.
const SHOW_ROBOT_QUEUE = false

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
  const [chatModalOpen, setChatModalOpen] = useState(false)
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState(false)
  const [lastReadSentAt, setLastReadSentAt] = useState(() => Date.now())
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isMuted, setIsMuted] = useState(false)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [previewOnly, setPreviewOnly] = useState(false)
  const [ownedStationIds, setOwnedStationIds] = useState<string[]>(() => getOwnedStationIds())
  const [djUserIds, setDJUserIds] = useState<string[]>([])
  const [serverConnected, setServerConnected] = useState<boolean | null>(null)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newStationName, setNewStationName] = useState("")
  const [createError, setCreateError] = useState<"" | "band-full" | "error">("")
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
  const [fontSheetOpen, setFontSheetOpen] = useState(false)
  const renameRef = useRef<HTMLInputElement>(null)
  const albumModalOpRef = useRef(0)
  const playbackLoop = useRef(new PlaybackLoop(new AppleMusicPlayer()))
  const catalog = useRef(new AppleMusicCatalog("us"))

  // Refresh the preview frequency whenever the create modal opens — purely
  // informational, not a reservation; the server still picks at creation.
  useEffect(() => {
    if (!createModalOpen) { setPreviewFrequency(null); return }
    const taken = new Set(stations.map(s => s.id))
    setPreviewFrequency(pickAvailableFreqId(taken))
  }, [createModalOpen, stations])

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
          console.log("[boot] session restored, completing auth silently")
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
        setChatMessages([])
        setLastReadSentAt(Date.now())
        playbackLoop.current.enableAutoplay()
        setStationSelected(true)
        setCurrentStationId(stationId)
      } else {
        playbackLoop.current.stop()
        setNowPlaying(null)
        setUpNext([])
        setStationLoading(false)
        setPlaybackBlocked(false)
        setChatMessages([])
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
    stationSocket.onChatUpdate = setChatMessages
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
    const existing = fullQueue.find(i =>
      (track.isrc && i.isrc === track.isrc) ||
      (track.platformIds?.apple && i.platformIds?.apple === track.platformIds.apple)
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
      console.error("[reauth]", err)
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
    window.history.pushState(null, "", `${import.meta.env.BASE_URL}${stationId}`)
    setNowPlaying(null)
    setUpNext([])
    setStationLoading(true)
    setPlaybackBlocked(false)
    setChatMessages([])
    setLastReadSentAt(Date.now())
    setSuggestions([])
    playbackLoop.current.enableAutoplay()
    setStationSelected(true)
    setCurrentStationId(stationId)
  }, [currentStationId])

  const handleRemoveStation = useCallback((stationId: string) => {
    indexSocket.removeStation(stationId)
    removeOwnedStationId(stationId)
    setOwnedStationIds(getOwnedStationIds())
    if (stationId === currentStationId) {
      const nextStation = stations.find(s => s.id !== stationId && s.liveUntil > Date.now())
      handleSelectStation(nextStation?.id ?? stations.find(s => s.id !== stationId)?.id ?? "")
    }
  }, [currentStationId, stations])

  const handleCreateStation = useCallback(async () => {
    if (!user) return
    const name = newStationName.trim()
    if (!name) return
    setIsCreatingStation(true)
    setCreateError("")
    const result = await indexSocket.createStation(user.uid, name, user.storefront)
    if (!result.ok) {
      setCreateError(result.reason)
      setIsCreatingStation(false)
      return
    }
    const freq = result.frequency
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
  }, [user, newStationName])

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
  const suggestedIsrcs = useMemo(() => new Set(
    suggestions.flatMap(s => [s.isrc, s.platformIds?.apple].filter(Boolean) as string[])
  ), [suggestions])
  const userQueue = useMemo(() => upNext.filter(item => item.addedBy !== "robot"), [upNext])
  const robotQueue = useMemo(() => upNext.filter(item => item.addedBy === "robot"), [upNext])
  const unreadCount = useMemo(
    () => chatMessages.filter(m => m.userId !== user?.uid && m.sentAt > lastReadSentAt).length,
    [chatMessages, lastReadSentAt, user?.uid]
  )
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
            queuedIsrcs={queuedIsrcs}
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
            queuedIsrcs={queuedIsrcs}
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
                className="text-amber-400 text-3xl font-mono font-bold text-center mb-6 tracking-wider"
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
            {(createError === "band-full" || createError === "error") && (
              <p className="text-red-400 text-xs mb-4">
                {createError === "band-full"
                  ? "The FM band is full — no frequencies available."
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
        {chatModalOpen && (
          <ChatModal
            onClose={() => setChatModalOpen(false)}
            messages={chatMessages}
            currentUser={user}
            onSend={(text) => stationSocket.sendChatMessage(text)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {discoveryModalOpen && (
          <DiscoveryModal
            onClose={() => setDiscoveryModalOpen(false)}
            catalog={catalog.current}
            queuedIsrcs={queuedIsrcs}
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
      <div className="flex-1 max-w-[480px] w-full mx-auto px-4 py-4 space-y-4">

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
          onOpenChat={() => {
            setLastReadSentAt(chatMessages[chatMessages.length - 1]?.sentAt ?? Date.now())
            setChatModalOpen(true)
          }}
          unreadCount={unreadCount}
          onOpenAddTracks={() => setDiscoveryModalOpen(true)}
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

        <ListenersPanel
          listeners={currentStation?.listeners ?? []}
          ownerUid={currentStation?.ownerUid}
          currentUserId={user.uid}
          djUserIds={djUserIds}
          isStationOwner={isOwnStation}
          onGrantDJ={(uid) => stationSocket.grantDJ(uid)}
          onRevokeDJ={(uid) => stationSocket.revokeDJ(uid)}
        />

        {SHOW_ROBOT_QUEUE && (
          <RobotQueue
            queue={robotQueue}
            onRemove={isPrivileged ? handleRemoveTrack : undefined}
            onAlbumClick={isPrivileged ? (item) => { if (item.platformIds?.apple) handleAlbumClick(item.platformIds.apple) } : undefined}
          />
        )}

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
            onClick={() => setFontSheetOpen(true)}
            className="font-mono text-muted/40 hover:text-white/70 transition-colors"
            title="Font test sheet"
          >Aa</button>
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

      {/* Font test sheet — Aa button in footer */}
      <AnimatePresence>
        {fontSheetOpen && (
          <motion.div
            className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/85 cursor-pointer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setFontSheetOpen(false)}
          >
            <motion.div
              className="bg-panel rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto cursor-default"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-white font-bold text-lg">Font test sheet</h2>
                <button onClick={() => setFontSheetOpen(false)} className="text-muted hover:text-white text-2xl leading-none">×</button>
              </div>
              {[
                { name: "JetBrains Mono",        family: "'JetBrains Mono', monospace" },
                { name: "IBM Plex Mono",         family: "'IBM Plex Mono', monospace" },
                { name: "Fira Code",             family: "'Fira Code', monospace" },
                { name: "Space Mono",            family: "'Space Mono', monospace" },
                { name: "VT323",                 family: "'VT323', monospace" },
                { name: "Major Mono Display",    family: "'Major Mono Display', monospace" },
                { name: "Press Start 2P",        family: "'Press Start 2P', monospace" },
                { name: "Inconsolata",           family: "'Inconsolata', monospace" },
                { name: "Roboto Mono",           family: "'Roboto Mono', monospace" },
                { name: "Cutive Mono",           family: "'Cutive Mono', monospace" },
              ].map(f => (
                <div key={f.name} className="mb-6 pb-5 border-b border-border/50 last:border-0">
                  <p className="text-muted/60 text-xs uppercase tracking-widest mb-2">{f.name}</p>
                  <p className="text-white text-3xl mb-1" style={{ fontFamily: f.family }}>hat.fm — 103.7</p>
                  <p className="text-amber-400 text-2xl mb-1" style={{ fontFamily: f.family }}>PARTY RADIO</p>
                  <p className="text-white/70 text-sm" style={{ fontFamily: f.family }}>abcdefghijklmnopqrstuvwxyz 0123456789</p>
                </div>
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
