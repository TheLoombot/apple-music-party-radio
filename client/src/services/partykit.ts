/**
 * PartyKit client — replaces Firebase Realtime Database.
 *
 * Two sockets:
 *  stationSocket  — connects to a station room, manages the queue
 *  indexSocket    — connects to the "index" room, manages station discovery
 */
import PartySocket from "partysocket"
import { log } from "./log"
import { migrateTrack } from "../../../shared/track"
import type { QueueItem, Track, PoolTrack, Station, LogEntry, Visit, SuggestedTrack } from "../types"

// In dev, partykit runs locally on port 1999.
// In production, set VITE_PARTYKIT_HOST to your deployed host, e.g.:
//   apple-music-party-radio.yourusername.partykit.dev
const HOST = import.meta.env.DEV
  ? `${window.location.hostname}:1999`
  : (import.meta.env.VITE_PARTYKIT_HOST as string)

function partyUrl(room: string, path = ""): string {
  const base = import.meta.env.DEV ? `http://${HOST}` : `https://${HOST}`
  return `${base}/parties/main/${encodeURIComponent(room)}${path}`
}

// ─── Station socket ───────────────────────────────────────────────────────────

export class StationSocket {
  private socket: PartySocket | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private lastJoinParams: { userId: string; displayName: string } | null = null

  onQueueUpdate?: (queue: QueueItem[]) => void
  onPoolUpdate?: (pool: PoolTrack[]) => void
  onLogUpdate?: (log: LogEntry[]) => void
  onVisitsUpdate?: (visits: Visit[]) => void
  onDJUpdate?: (djUserIds: string[]) => void
  onQueueFull?: (limit: number) => void
  onSuggestionsUpdate?: (suggestions: SuggestedTrack[]) => void
  onSuggestionsFull?: (limit: number) => void
  onDJNotesUpdate?: (notes: Record<string, string>) => void
  onHeartsUpdate?: (trackHearts: Record<string, number>, djHearts: Record<string, number>) => void

  connect(stationId: string) {
    this.disconnect()
    const opts = import.meta.env.DEV
      ? { host: HOST, room: stationId, protocol: "ws" as const }
      : { host: HOST, room: stationId }
    this.socket = new PartySocket(opts)

    // Resend join on every (re)connect so the server's connListeners map stays
    // fresh after reconnects (e.g. server restart, network blip). Without this,
    // chat and presence are silently broken because the server requires a join
    // before it'll process chat messages or include the user in the listener list.
    this.socket.onopen = () => {
      log.net.info("station socket open", { room: stationId })
      if (this.lastJoinParams) {
        this.socket?.send(JSON.stringify({ type: "join", ...this.lastJoinParams }))
      }
    }
    this.socket.onclose = () => log.net.info("station socket closed", { room: stationId })

    this.socket.onmessage = (e) => {
      let msg: any
      try { msg = JSON.parse(e.data) } catch (err) {
        log.net.error("StationSocket failed to parse message:", err)
        return
      }
      if (msg.type === "state") {
        this.onQueueUpdate?.((msg.queue ?? []).filter(Boolean).map(migrateTrack))
        this.onPoolUpdate?.((msg.pool ?? []).filter(Boolean).map(migrateTrack))
        this.onLogUpdate?.(msg.log ?? [])
        this.onVisitsUpdate?.(msg.visits ?? [])
        if (msg.djs) this.onDJUpdate?.(msg.djs)
        if (msg.suggestions) this.onSuggestionsUpdate?.((msg.suggestions as any[]).filter(Boolean).map(migrateTrack))
        if (msg.djNotes) this.onDJNotesUpdate?.(msg.djNotes)
        this.onHeartsUpdate?.(msg.trackHearts ?? {}, msg.djHearts ?? {})
      } else if (msg.type === "hearts_update") {
        this.onHeartsUpdate?.(msg.trackHearts ?? {}, msg.djHearts ?? {})
      } else if (msg.type === "queue_update") {
        this.onQueueUpdate?.((msg.queue ?? []).filter(Boolean).map(migrateTrack))
      } else if (msg.type === "pool_update") {
        this.onPoolUpdate?.((msg.pool ?? []).filter(Boolean).map(migrateTrack))
      } else if (msg.type === "log_update") {
        this.onLogUpdate?.(msg.log ?? [])
      } else if (msg.type === "visits_update") {
        this.onVisitsUpdate?.(msg.visits ?? [])
      } else if (msg.type === "dj_update") {
        this.onDJUpdate?.(msg.djs ?? [])
      } else if (msg.type === "queue_full") {
        this.onQueueFull?.(msg.limit)
      } else if (msg.type === "suggestions_update") {
        this.onSuggestionsUpdate?.((msg.suggestions ?? []).filter(Boolean).map(migrateTrack))
      } else if (msg.type === "suggestions_full") {
        this.onSuggestionsFull?.(msg.limit)
      } else if (msg.type === "dj_notes_update") {
        this.onDJNotesUpdate?.(msg.djNotes ?? {})
      }
    }

    this.socket.onerror = (e) => log.net.error("StationSocket error:", e)

    // Keep the WebSocket alive while the tab is backgrounded on iOS.
    // The server ignores unknown message types so this is a no-op server-side.
    this.pingInterval = setInterval(() => this.send({ type: "ping" }), 20_000)
  }

  disconnect() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null }
    this.socket?.close()
    this.socket = null
  }

  join(userId: string, displayName: string) {
    this.lastJoinParams = { userId, displayName }
    this.send({ type: "join", userId, displayName })
  }

  addTrack(track: Track, addedBy: string) {
    this.send({ type: "add_track", track, addedBy })
  }

  removeTrack(key: string) {
    this.send({ type: "remove_track", key })
  }

  skipTrack() {
    this.send({ type: "skip_track" })
  }

  skipAndRemoveFromPool() {
    this.send({ type: "skip_and_remove_from_pool" })
  }

  expireTrack(key: string, addToPool: boolean) {
    this.send({ type: "expire_track", key, addToPool })
  }

  reorderQueue(keys: string[]) {
    this.send({ type: "reorder_queue", keys })
  }

  removeFromPool(isrc: string) {
    this.send({ type: "remove_from_pool", isrc })
  }

  clearPool() {
    this.send({ type: "clear_pool" })
  }

  triggerRobotDJ() {
    this.send({ type: "robot_dj" })
  }

  /** Post a chat message to the station log. */
  postMessage(text: string) {
    this.send({ type: "post_message", text, ...this.lastJoinParams })
  }

  grantDJ(userId: string) {
    this.send({ type: "grant_dj", userId })
  }

  revokeDJ(userId: string) {
    this.send({ type: "revoke_dj", userId })
  }

  suggestTrack(track: Track) {
    this.send({ type: "suggest_track", track })
  }

  voteSuggestion(key: string) {
    this.send({ type: "vote_suggestion", key })
  }

  enqueueSuggestion(key: string) {
    this.send({ type: "enqueue_suggestion", key })
  }

  removeSuggestion(key: string) {
    this.send({ type: "remove_suggestion", key })
  }

  setDjNote(itemId: string, note: string) {
    this.send({ type: "set_dj_note", itemId, note })
  }

  /** Debug only — seize ownership of the current station for the given user.
   *  Server-side has no auth check; the button that calls this is in the
   *  debug menu. */
  transferOwnership(userId: string, displayName: string) {
    this.send({ type: "transfer_ownership", userId, displayName })
  }

  /** Toggle the current user's heart on the currently-playing track. */
  heart(key: string, userId: string) {
    this.send({ type: "heart", key, userId })
  }

  private send(data: object) {
    if (!this.socket) return
    // PartySocket buffers messages if not yet connected
    this.socket.send(JSON.stringify(data))
  }
}

// ─── Index socket (station discovery) ────────────────────────────────────────

export class IndexSocket {
  private socket: PartySocket | null = null
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null
  onStationsUpdate?: (stations: Station[]) => void
  onConnectionChange?: (connected: boolean) => void

  connect() {
    this.disconnect()
    const opts = import.meta.env.DEV
      ? { host: HOST, room: "index", protocol: "ws" as const }
      : { host: HOST, room: "index" }
    this.socket = new PartySocket(opts)
    this.socket.onopen = () => {
      log.net.info("index socket open")
      if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null }
      this.onConnectionChange?.(true)
    }
    this.socket.onclose = () => {
      log.net.info("index socket closed")
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null
        this.onConnectionChange?.(false)
      }, 5000)
    }
    this.socket.onmessage = (e) => {
      let msg: any
      try { msg = JSON.parse(e.data) } catch (err) {
        log.net.error("IndexSocket failed to parse message:", err)
        return
      }
      if (msg.type === "stations_update") {
        this.onStationsUpdate?.(msg.stations ?? [])
      }
    }
  }

  disconnect() {
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null }
    const s = this.socket
    this.socket = null
    if (s) { s.onclose = null; s.close() }
  }

  register(id: string, displayName: string, storefront: string, ownerUid?: string, frequency?: number, ownerDisplayName?: string) {
    this.socket?.send(JSON.stringify({ type: "register", id, displayName, storefront, ownerUid, frequency, ownerDisplayName }))
  }

  removeStation(id: string, ownerUid: string) {
    this.socket?.send(JSON.stringify({ type: "remove_station", id, ownerUid }))
  }

  /** Publish the roaming display name for a uid (DJ profile portability). */
  setProfile(uid: string, displayName: string) {
    this.socket?.send(JSON.stringify({ type: "set_profile", uid, displayName }))
  }

  /** Look up the roaming display name for a uid. Plain HTTP — usable before
   *  the index socket is connected (i.e. during completeAuth). */
  async getProfile(uid: string): Promise<string | null> {
    try {
      const res = await fetch(partyUrl("index", `/profile?uid=${encodeURIComponent(uid)}`))
      if (!res.ok) return null
      const data = await res.json() as { displayName: string | null }
      return data.displayName ?? null
    } catch {
      return null
    }
  }

  /** Asks the server to assign an available frequency and create the station.
   *  The server requires the `preferredFreq` (the preview the user saw) and
   *  returns "slot-taken" if it got claimed in the meantime, or "band-full"
   *  if no `preferredFreq` was sent and every slot is full. */
  async createStation(ownerUid: string, displayName: string, storefront: string, preferredFreq?: string): Promise<{ ok: true; frequency: string } | { ok: false; reason: "band-full" | "slot-taken" | "error" }> {
    try {
      const res = await fetch(partyUrl("index", "/create-station"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerUid, displayName, storefront, preferredFreq }),
      })
      if (res.status === 409) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        if (body.error === "slot-taken") return { ok: false, reason: "slot-taken" }
        return { ok: false, reason: "band-full" }
      }
      if (!res.ok) return { ok: false, reason: "error" }
      const data = await res.json() as { frequency: string }
      return { ok: true, frequency: data.frequency }
    } catch {
      return { ok: false, reason: "error" }
    }
  }
}

// Singletons
export const stationSocket = new StationSocket()
export const indexSocket = new IndexSocket()
