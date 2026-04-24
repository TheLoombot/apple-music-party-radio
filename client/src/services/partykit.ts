/**
 * PartyKit client — replaces Firebase Realtime Database.
 *
 * Two sockets:
 *  stationSocket  — connects to a station room, manages the queue
 *  indexSocket    — connects to the "index" room, manages station discovery
 */
import PartySocket from "partysocket"
import type { QueueItem, Track, PoolTrack, Station, ChatMessage } from "../types"

// Ensure every track from the server has a platformIds object.
// Mirrors the server-side migrateTrack — runs on every received queue/pool item.
function migrateTrack<T extends object>(item: T): T {
  const t = item as any
  if (t?.platformIds) return item
  return { ...item, platformIds: { apple: t?.catalogId }, addedViaPlatform: t?.addedViaPlatform ?? "apple" }
}

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
  private chatMessages: ChatMessage[] = []
  private lastJoinParams: { userId: string; displayName: string } | null = null

  onQueueUpdate?: (queue: QueueItem[]) => void
  onPoolUpdate?: (pool: PoolTrack[]) => void
  onChatUpdate?: (messages: ChatMessage[]) => void
  onDJUpdate?: (djUserIds: string[]) => void
  onQueueFull?: (limit: number) => void

  connect(stationId: string) {
    this.disconnect()
    this.chatMessages = []
    const opts = import.meta.env.DEV
      ? { host: HOST, room: stationId, protocol: "ws" as const }
      : { host: HOST, room: stationId }
    this.socket = new PartySocket(opts)

    // Resend join on every (re)connect so the server's connListeners map stays
    // fresh after reconnects (e.g. server restart, network blip). Without this,
    // chat and presence are silently broken because the server requires a join
    // before it'll process chat messages or include the user in the listener list.
    this.socket.onopen = () => {
      if (this.lastJoinParams) {
        this.socket?.send(JSON.stringify({ type: "join", ...this.lastJoinParams }))
      }
    }

    this.socket.onmessage = (e) => {
      let msg: any
      try { msg = JSON.parse(e.data) } catch (err) {
        console.error("[StationSocket] failed to parse message:", err)
        return
      }
      if (msg.type === "state") {
        this.onQueueUpdate?.((msg.queue ?? []).filter(Boolean).map(migrateTrack))
        this.onPoolUpdate?.((msg.pool ?? []).filter(Boolean).map(migrateTrack))
        this.chatMessages = msg.chat ?? []
        this.onChatUpdate?.([...this.chatMessages])
        if (msg.djs) this.onDJUpdate?.(msg.djs)
      } else if (msg.type === "queue_update") {
        this.onQueueUpdate?.((msg.queue ?? []).filter(Boolean).map(migrateTrack))
      } else if (msg.type === "pool_update") {
        this.onPoolUpdate?.((msg.pool ?? []).filter(Boolean).map(migrateTrack))
      } else if (msg.type === "chat_message") {
        this.chatMessages = [...this.chatMessages, msg.message].slice(-100)
        this.onChatUpdate?.([...this.chatMessages])
      } else if (msg.type === "dj_update") {
        this.onDJUpdate?.(msg.djs ?? [])
      } else if (msg.type === "queue_full") {
        this.onQueueFull?.(msg.limit)
      }
    }

    this.socket.onerror = (e) => console.error("[StationSocket]", e)

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

  sendChatMessage(text: string) {
    this.send({ type: "chat_message", text })
  }

  grantDJ(userId: string) {
    this.send({ type: "grant_dj", userId })
  }

  revokeDJ(userId: string) {
    this.send({ type: "revoke_dj", userId })
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
      if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null }
      this.onConnectionChange?.(true)
    }
    this.socket.onclose = () => {
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null
        this.onConnectionChange?.(false)
      }, 5000)
    }
    this.socket.onmessage = (e) => {
      let msg: any
      try { msg = JSON.parse(e.data) } catch (err) {
        console.error("[IndexSocket] failed to parse message:", err)
        return
      }
      if (msg.type === "stations_update") {
        this.onStationsUpdate?.(msg.stations ?? [])
      }
    }
  }

  disconnect() {
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null }
    this.socket?.close()
    this.socket = null
  }

  register(id: string, displayName: string, storefront: string, ownerUid?: string) {
    this.socket?.send(JSON.stringify({ type: "register", id, displayName, storefront, ownerUid }))
  }

  removeStation(id: string) {
    this.socket?.send(JSON.stringify({ type: "remove_station", id }))
  }

  async checkSlugAvailable(slug: string): Promise<boolean> {
    try {
      const res = await fetch(partyUrl("index", `?check=${encodeURIComponent(slug)}`))
      const data = await res.json() as { taken: boolean }
      return !data.taken
    } catch {
      return false
    }
  }

  async createStation(slug: string, ownerUid: string, displayName: string, storefront: string): Promise<'ok' | 'taken'> {
    try {
      const res = await fetch(partyUrl(slug, "/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerUid, displayName, storefront }),
      })
      if (res.status === 409) return "taken"
      return "ok"
    } catch {
      return "taken"
    }
  }
}

// Singletons
export const stationSocket = new StationSocket()
export const indexSocket = new IndexSocket()
