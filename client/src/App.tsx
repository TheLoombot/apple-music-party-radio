import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { AnimatePresence } from "framer-motion"
import { SetupScreen } from "./components/SetupScreen"
import { NowPlaying } from "./components/NowPlaying"
import { UpNext } from "./components/UpNext"
import { RobotQueue } from "./components/RobotQueue"
import { PoolModal } from "./components/PoolModal"
import { StationModal } from "./components/StationModal"
import { ChatModal } from "./components/ChatModal"
import { DiscoveryModal } from "./components/DiscoveryModal"
import { ListenersPanel } from "./components/ListenersPanel"
import { PlaylistModal } from "./components/PlaylistModal"
import { initMusicKit, authorize, isAuthorized, getMusicKit } from "./services/musickit"
import { getUserStorefront } from "./services/appleMusic"
import { getUserId, getDisplayName, setDisplayName, getOwnedStationIds, addOwnedStationId, removeOwnedStationId, getStationName, setStationName } from "./services/identity"
import { stationSocket, indexSocket } from "./services/partykit"
import { PlaybackLoop } from "./services/playbackLoop"
import { AppleMusicPlayer } from "./services/appleMusicPlayer"
import { AppleMusicCatalog } from "./services/catalog"
import type { AppUser, Station, QueueItem, Track, AlbumResult, PoolTrack, ChatMessage, SuggestedTrack } from "./types"

type AppState = "loading" | "setup" | "naming" | "auth" | "ready"

const DEV_TOKEN_SET = !!import.meta.env.VITE_APPLE_DEVELOPER_TOKEN

export default function App() {
  const [appState, setAppState] = useState<AppState>("loading")
  const [setupError, setSetupError] = useState<string>()
  const [user, setUser] = useState<AppUser | null>(null)
  const [nameInput, setNameInput] = useState("")
  const [stations, setStations] = useState<Station[]>([])
  const [currentStationId, setCurrentStationId] = useState("")
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
  const [newSlug, setNewSlug] = useState("")
  const [slugStatus, setSlugStatus] = useState<"idle" | "checking" | "available" | "taken">("idle")
  const [isCreatingStation, setIsCreatingStation] = useState(false)
  const [renamingDJ, setRenamingDJ] = useState(false)
  const [renameInput, setRenameInput] = useState("")
  const [queueFullAlert, setQueueFullAlert] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestedTrack[]>([])
  const [suggestionsFullAlert, setSuggestionsFullAlert] = useState<number | null>(null)
  const [albumModal, setAlbumModal] = useState<{ playlist: AlbumResult; tracks: Track[] | null } | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const albumModalOpRef = useRef(0)
  const playbackLoop = useRef(new PlaybackLoop(new AppleMusicPlayer()))
  const catalog = useRef(new AppleMusicCatalog("us"))

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
      // On first update, auto-select a station if none is set
      if (!didSetInitialStation) {
        didSetInitialStation = true
        setCurrentStationId(prev => {
          if (prev) return prev
          // URL path takes priority — allows direct links to a station
          const pathStation = window.location.pathname.slice(import.meta.env.BASE_URL.length)
          if (pathStation) return pathStation
          // Prefer own live station, then any live station, then first in list
          const owned = getOwnedStationIds()
          const ownLive = newStations.find(s => owned.includes(s.id) && s.liveUntil > Date.now())
          const firstLive = newStations.find(s => s.liveUntil > Date.now())
          return ownLive?.id ?? firstLive?.id ?? newStations[0]?.id ?? ""
        })
      }
    }
    indexSocket.connect()
    // Register owned stations; remove any legacy UUID-shaped IDs left over from the
    // old 1:1 uid→station model (they were never real named stations).
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const owned = getOwnedStationIds()
    for (const stationId of owned) {
      if (uuidRe.test(stationId)) {
        indexSocket.removeStation(stationId)
        removeOwnedStationId(stationId)
      } else {
        indexSocket.register(stationId, getStationName(stationId), user.storefront, user.uid)
      }
    }
    setOwnedStationIds(getOwnedStationIds())

    // Sync path → station on browser back/forward
    const onPopState = () => {
      const stationId = window.location.pathname.slice(import.meta.env.BASE_URL.length)
      if (stationId) {
        setNowPlaying(null)
        setUpNext([])
        setPlaybackBlocked(false)
        setChatMessages([])
        setLastReadSentAt(Date.now())
        playbackLoop.current.enableAutoplay()
        setCurrentStationId(stationId)
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
    playbackLoop.current.onNowPlayingChange = setNowPlaying
    playbackLoop.current.onPreviewOnly = () => setPreviewOnly(true)
    playbackLoop.current.onQueueChange = setUpNext
    playbackLoop.current.onPlaybackBlocked = () => setPlaybackBlocked(true)
    playbackLoop.current.onMutedChange = setIsMuted
    stationSocket.onPoolUpdate = setPool
    stationSocket.onChatUpdate = setChatMessages
    stationSocket.onDJUpdate = setDJUserIds
    stationSocket.onQueueFull = (limit) => setQueueFullAlert(limit)
    stationSocket.onSuggestionsUpdate = setSuggestions
    stationSocket.onSuggestionsFull = (limit) => setSuggestionsFullAlert(limit)
    setDJUserIds([])
    setSuggestions([])
    playbackLoop.current.start(currentStationId)
    stationSocket.join(user.uid, user.displayName)
    return () => playbackLoop.current.stop()
  }, [currentStationId, appState, user])

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
    if (!track.platformIds?.apple) return  // no playable Apple ID — don't add
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
      indexSocket.register(stationId, getStationName(stationId), user.storefront, user.uid)
    }
    setRenamingDJ(false)
  }, [user, renameInput])

  const handleRenameStation = useCallback((newName: string) => {
    if (!user || !currentStationId) return
    const name = newName.trim() || currentStationId
    setStationName(currentStationId, name)
    indexSocket.register(currentStationId, name, user.storefront, user.uid)
  }, [user, currentStationId])

  const handleSelectStation = useCallback((stationId: string) => {
    if (stationId === currentStationId) return
    window.history.pushState(null, "", `${import.meta.env.BASE_URL}${stationId}`)
    setNowPlaying(null)
    setUpNext([])
    setPlaybackBlocked(false)
    setChatMessages([])
    setLastReadSentAt(Date.now())
    setSuggestions([])
    playbackLoop.current.enableAutoplay()
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

  // Debounce slug availability check
  useEffect(() => {
    const slug = newSlug.trim().toLowerCase()
    if (!slug || slug.length < 2) { setSlugStatus("idle"); return }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) && slug.length > 1) { setSlugStatus("idle"); return }
    setSlugStatus("checking")
    const timer = setTimeout(async () => {
      const available = await indexSocket.checkSlugAvailable(slug)
      setSlugStatus(available ? "available" : "taken")
    }, 400)
    return () => clearTimeout(timer)
  }, [newSlug])

  const handleCreateStation = useCallback(async () => {
    if (!user || slugStatus !== "available") return
    const slug = newSlug.trim().toLowerCase()
    setIsCreatingStation(true)
    const result = await indexSocket.createStation(slug, user.uid, slug, user.storefront)
    if (result === "taken") {
      setSlugStatus("taken")
      setIsCreatingStation(false)
      return
    }
    setStationName(slug, slug)
    addOwnedStationId(slug)
    setOwnedStationIds(getOwnedStationIds())
    indexSocket.register(slug, slug, user.storefront, user.uid)
    setCreateModalOpen(false)
    setNewSlug("")
    setSlugStatus("idle")
    setIsCreatingStation(false)
    handleSelectStation(slug)
  }, [user, newSlug, slugStatus])

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

      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={() => setCreateModalOpen(false)}>
          <div className="bg-panel rounded-2xl p-8 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="text-white font-bold text-lg mb-1">Create a station</h2>
            <p className="text-muted text-sm mb-6">Pick a unique slug for your station's URL.</p>
            <div className="relative mb-2">
              <input
                autoFocus
                type="text"
                value={newSlug}
                onChange={e => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30))}
                onKeyDown={e => { if (e.key === "Enter") handleCreateStation(); if (e.key === "Escape") setCreateModalOpen(false) }}
                placeholder="my-cool-station"
                className="w-full bg-surface text-white placeholder-muted rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-accent pr-24"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs">
                {slugStatus === "checking" && <span className="text-muted">checking…</span>}
                {slugStatus === "available" && <span className="text-green-400">available</span>}
                {slugStatus === "taken" && <span className="text-red-400">taken</span>}
              </span>
            </div>
            <p className="text-muted/60 text-xs mb-6">Lowercase letters, numbers, and hyphens only.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setCreateModalOpen(false)}
                className="flex-1 py-3 rounded-xl bg-surface text-muted font-semibold text-sm transition-colors hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateStation}
                disabled={slugStatus !== "available" || isCreatingStation}
                className="flex-1 py-3 rounded-xl bg-accent hover:bg-accent-hover text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isCreatingStation ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
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
      <div className="flex-1 max-w-[480px] w-full mx-auto px-4 py-4 space-y-4">

        <NowPlaying
          track={nowPlaying}
          stationOwner={currentStationId}
          currentUser={user}
          canSkip={isPrivileged}
          onSkip={handleSkip}
          isMuted={isMuted}
          onMuteToggle={handleMuteToggle}
          isBlocked={playbackBlocked}
          onResume={handleResume}
          onAlbumClick={isPrivileged && nowPlaying?.platformIds?.apple ? () => handleAlbumClick(nowPlaying.platformIds!.apple!) : undefined}
          onOpenPool={isPrivileged ? () => setPoolModalOpen(true) : undefined}
          catalog={catalog.current}
          stationName={stations.find(s => s.id === currentStationId)?.displayName || currentStationId}
          isOwner={isOwnStation}
          onRenameStation={isOwnStation ? handleRenameStation : undefined}
          onOpenStationModal={() => setStationModalOpen(true)}
          activeStationCount={activeStationCount}
        />

        <button
          onClick={() => setDiscoveryModalOpen(true)}
          className="w-full py-4 bg-accent hover:bg-accent-hover text-white font-bold text-base rounded-xl transition-colors tracking-wide"
        >
          {isPrivileged ? "+ ADD" : "+ REQUEST"}
        </button>

        {(() => {
          const currentStation = stations.find(s => s.id === currentStationId)
          return (
            <ListenersPanel
              listeners={currentStation?.listeners ?? []}
              ownerUid={currentStation?.ownerUid}
              currentUserId={user.uid}
              djUserIds={djUserIds}
              isStationOwner={isOwnStation}
              onGrantDJ={(uid) => stationSocket.grantDJ(uid)}
              onRevokeDJ={(uid) => stationSocket.revokeDJ(uid)}
              onOpenChat={() => {
                setLastReadSentAt(chatMessages[chatMessages.length - 1]?.sentAt ?? Date.now())
                setChatModalOpen(true)
              }}
              unreadCount={unreadCount}
            />
          )
        })()}

        <UpNext
          queue={userQueue}
          currentUser={user}
          stationOwner={currentStationId}
          onRemove={handleRemoveTrack}
          onReorder={isPrivileged ? (keys) => stationSocket.reorderQueue(keys) : undefined}
          onAlbumClick={isPrivileged ? (item) => { if (item.platformIds?.apple) handleAlbumClick(item.platformIds.apple) } : undefined}
        />

        <RobotQueue
          queue={robotQueue}
          onRemove={isPrivileged ? handleRemoveTrack : undefined}
          onAlbumClick={isPrivileged ? (item) => { if (item.platformIds?.apple) handleAlbumClick(item.platformIds.apple) } : undefined}
        />

      </div>

      {/* Footer */}
      <footer className="border-t border-border/50 max-w-[480px] w-full mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted/40">
          <span>🎵</span>
          <span>Party Radio</span>
          <span className="font-mono text-muted/25">{__COMMIT__}</span>
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
    </div>
  )
}
