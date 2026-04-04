import { useState, useEffect, useCallback, useRef } from "react"
import { AnimatePresence } from "framer-motion"
import { SetupScreen } from "./components/SetupScreen"
import { NowPlaying } from "./components/NowPlaying"
import { UpNext } from "./components/UpNext"
import { SearchTracks } from "./components/AddTracks"
import { PoolModal } from "./components/PoolModal"
import { StationChat } from "./components/StationChat"
import { Discovery } from "./components/Discovery"
import { StationList } from "./components/StationList"
import { FaceGenerator } from "./components/FaceGenerator"
import { PlaylistModal } from "./components/PlaylistModal"
import { initMusicKit, authorize, isAuthorized } from "./services/musickit"
import { getUserStorefront } from "./services/appleMusic"
import { getUserId, getDisplayName, setDisplayName } from "./services/identity"
import { stationSocket, indexSocket } from "./services/partykit"
import { PlaybackLoop } from "./services/playbackLoop"
import { AppleMusicPlayer } from "./services/appleMusicPlayer"
import { AppleMusicCatalog } from "./services/catalog"
import type { AppUser, Station, QueueItem, Track, AlbumResult, PoolTrack, ChatMessage } from "./types"

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
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isMuted, setIsMuted] = useState(false)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [renamingDJ, setRenamingDJ] = useState(false)
  const [renameInput, setRenameInput] = useState("")
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
    indexSocket.onStationsUpdate = setStations
    indexSocket.connect()
    indexSocket.register(user.uid, user.displayName, user.storefront)
    return () => indexSocket.disconnect()
  }, [appState, user])

  // Start playback loop when station changes
  useEffect(() => {
    if (appState !== "ready" || !currentStationId || !user) return
    playbackLoop.current.onNowPlayingChange = setNowPlaying
    playbackLoop.current.onQueueChange = setUpNext
    playbackLoop.current.onPlaybackBlocked = () => setPlaybackBlocked(true)
    playbackLoop.current.onMutedChange = setIsMuted
    stationSocket.onPoolUpdate = setPool
    stationSocket.onChatUpdate = setChatMessages
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
    setCurrentStationId(uid)
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

  const handleMuteToggle = useCallback(() => {
    playbackLoop.current.setMuted(!isMuted)
  }, [isMuted])

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
    indexSocket.register(user.uid, name, user.storefront)
    setRenamingDJ(false)
  }, [user, renameInput])

  const handleSelectStation = useCallback((stationId: string) => {
    if (stationId === currentStationId) return
    setNowPlaying(null)
    setUpNext([])
    setPlaybackBlocked(false)
    setChatMessages([])
    playbackLoop.current.enableAutoplay()
    setCurrentStationId(stationId)
  }, [currentStationId])

  const handleRemoveStation = useCallback((stationId: string) => {
    indexSocket.removeStation(stationId)
    if (stationId === currentStationId) handleSelectStation(user!.uid)
  }, [currentStationId])

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

  const isOwnStation = currentStationId === user.uid
  // Include both ISRCs and Apple catalog IDs — library tracks often have no ISRC
  const queuedIsrcs = new Set(
    [...(nowPlaying ? [nowPlaying] : []), ...upNext]
      .flatMap(i => [i.isrc, i.platformIds?.apple])
      .filter(Boolean) as string[]
  )

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🎵</span>
          <span className="text-white font-semibold">Apple Music Party Radio</span>
        </div>
        <div className="text-muted text-xs flex items-center gap-3">
          <span className="text-muted/40 font-mono">{__COMMIT__}</span>
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
              className="text-muted hover:text-white transition-colors group"
              title="Click to rename"
            >
              DJ <span className="text-white group-hover:underline decoration-dotted">{user.displayName}</span>
            </button>
          )}
        </div>
      </header>

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
            stationOwner={currentStationId}
            queuedIsrcs={queuedIsrcs}
            onAddTrack={handleAddTrack}
            onRemoveFromPool={handleRemoveFromPool}
            onClearPool={handleClearPool}
            onClose={() => setPoolModalOpen(false)}
            catalog={catalog.current}
          />
        )}
      </AnimatePresence>

      {/* Main layout */}
      <div className="max-w-5xl mx-auto p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-4">
          <NowPlaying
            track={nowPlaying}
            stationOwner={currentStationId}
            currentUser={user}
            canSkip={isOwnStation}
            onSkip={handleSkip}
            isMuted={isMuted}
            onMuteToggle={handleMuteToggle}
            isBlocked={playbackBlocked}
            onResume={handleResume}
            onAlbumClick={isOwnStation && nowPlaying?.platformIds?.apple ? () => handleAlbumClick(nowPlaying.platformIds!.apple!) : undefined}
            onOpenPool={isOwnStation ? () => setPoolModalOpen(true) : undefined}
          />
          <UpNext
            queue={isOwnStation ? upNext : upNext.slice(0, 1)}
            currentUser={user}
            stationOwner={currentStationId}
            onRemove={handleRemoveTrack}
            onReorder={isOwnStation ? (keys) => stationSocket.reorderQueue(keys) : undefined}
            onAlbumClick={isOwnStation ? (item) => { if (item.platformIds?.apple) handleAlbumClick(item.platformIds.apple) } : undefined}
          />
        </div>
        <div className="space-y-4">
          <StationList
            stations={stations}
            currentStationId={currentStationId}
            ownStationId={user.uid}
            onSelect={handleSelectStation}
            onRemove={handleRemoveStation}
          />
          <StationChat
            messages={chatMessages}
            currentUser={user}
            onSend={(text) => stationSocket.sendChatMessage(text)}
          />
          {isOwnStation && (
            <>
              <Discovery
                catalog={catalog.current}
                queuedIsrcs={queuedIsrcs}
                queue={[...(nowPlaying ? [nowPlaying] : []), ...upNext]}
                onAddTrack={handleAddTrack}
              />
              <SearchTracks
                currentUser={user}
                catalog={catalog.current}
                onAddTrack={handleAddTrack}
                queuedIsrcs={queuedIsrcs}
              />
              <FaceGenerator />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
