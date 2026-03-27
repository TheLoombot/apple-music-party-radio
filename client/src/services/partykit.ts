/**
 * PartyKit client — replaces Firebase Realtime Database.
 *
 * Two sockets:
 *  stationSocket  — connects to a station room, manages the queue
 *  indexSocket    — connects to the "index" room, manages station discovery
 */
import PartySocket from "partysocket"
import type { QueueItem, Track, Station } from "../types"

// In dev, partykit runs locally on port 1999.
// In production, set VITE_PARTYKIT_HOST to your deployed host, e.g.:
//   apple-music-party-radio.yourusername.partykit.dev
const HOST = import.meta.env.DEV
  ? `${window.location.hostname}:1999`
  : (import.meta.env.VITE_PARTYKIT_HOST as string)

const PARTY_OPTIONS = import.meta.env.DEV ? { protocol: "ws" } : {}

// ─── Station socket ───────────────────────────────────────────────────────────

export class StationSocket {
  private socket: PartySocket | null = null

  onQueueUpdate?: (queue: QueueItem[]) => void
  onPoolUpdate?: (pool: Track[]) => void

  connect(stationId: string) {
    this.disconnect()
    this.socket = new PartySocket({ host: HOST, room: stationId, ...PARTY_OPTIONS })

    this.socket.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === "state") {
        this.onQueueUpdate?.(msg.queue ?? [])
        this.onPoolUpdate?.(msg.pool ?? [])
      } else if (msg.type === "queue_update") {
        this.onQueueUpdate?.(msg.queue ?? [])
      } else if (msg.type === "pool_update") {
        this.onPoolUpdate?.(msg.pool ?? [])
      }
    }

    this.socket.onerror = (e) => console.error("[StationSocket]", e)
  }

  disconnect() {
    this.socket?.close()
    this.socket = null
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

  removeFromPool(catalogId: string) {
    this.send({ type: "remove_from_pool", catalogId })
  }

  clearPool() {
    this.send({ type: "clear_pool" })
  }

  triggerRobotDJ() {
    this.send({ type: "robot_dj" })
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
  onStationsUpdate?: (stations: Station[]) => void

  connect() {
    this.disconnect()
    this.socket = new PartySocket({ host: HOST, room: "index", ...PARTY_OPTIONS })
    this.socket.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === "stations_update") {
        this.onStationsUpdate?.(msg.stations ?? [])
      }
    }
  }

  disconnect() {
    this.socket?.close()
    this.socket = null
  }

  register(id: string, displayName: string, storefront: string) {
    this.socket?.send(JSON.stringify({ type: "register", id, displayName, storefront }))
  }

  removeStation(id: string) {
    this.socket?.send(JSON.stringify({ type: "remove_station", id }))
  }
}

// Singletons
export const stationSocket = new StationSocket()
export const indexSocket = new IndexSocket()
