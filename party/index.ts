/**
 * Apple Music Party Radio — PartyKit server
 *
 * Runs on Cloudflare Durable Objects via PartyKit.
 * Each radio station is a separate room identified by the owner's user ID.
 * A special "index" room maintains the list of all registered stations.
 *
 * Room: "index"
 *   Handles station registration and discovery.
 *   Receives live-status pings from station rooms via HTTP POST.
 *
 * Room: "{userId}"
 *   Handles the queue, song pool, and all playback state for one station.
 */
import type * as Party from "partykit/server"

// ─── Shared types (mirrored from client/src/types.ts) ────────────────────────

interface PlatformIds {
  apple?: string
  spotify?: string
}

interface Track {
  isrc: string
  platformIds: PlatformIds
  addedViaPlatform: string
  name: string
  artistName: string
  albumName: string
  artworkUrl: string
  durationMs: number
}

interface QueueItem extends Track {
  key: string
  expirationTime: number
  addedBy: string
  addedAt: number
}

interface PoolTrack extends Track {
  lastPlayedAt: number
}

interface Listener {
  userId: string
  displayName: string
}

interface StationMeta {
  id: string
  displayName: string
  storefront: string
  liveUntil: number   // Unix ms; 0 = not live; client computes isLive as liveUntil > Date.now()
  nowPlayingAddedBy?: string
  listeners?: Listener[]
}

// ─── Server ───────────────────────────────────────────────────────────────────

export default class RadioParty implements Party.Server {
  constructor(readonly room: Party.Room) {}

  // Station rooms: connId → listener info (ephemeral, not persisted)
  private connListeners = new Map<string, Listener>()

  // Index room: stationId → listener list (ephemeral, not persisted)
  private presenceMap = new Map<string, Listener[]>()

  /** Send current state to a newly connected client */
  async onConnect(conn: Party.Connection) {
    if (this.room.id === "index") {
      const stations = await this.storage<StationMeta[]>("stations", [])
      conn.send(json({ type: "stations_update", stations: this.withPresence(stations) }))
    } else {
      const { queue, pool } = await this.flushExpired()
      conn.send(json({ type: "state", queue, pool }))
      // Sync live status to index on every connect so stale flags get corrected
      void this.notifyIndex(liveUntilFromQueue(queue), queue[0]?.addedBy)
      // Re-arm expiration alarm in case the DO restarted and lost it
      if (queue.length > 0) {
        void this.room.storage.setAlarm(queue[0].expirationTime)
      }
    }
  }

  async onAlarm() {
    if (this.room.id === "index") return
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length === 0) return
    if (Date.now() >= queue[0].expirationTime) {
      await this.expireTrack(queue[0].key, true)
    }
  }

  async onClose(conn: Party.Connection) {
    if (this.room.id === "index") return
    this.connListeners.delete(conn.id)
    void this.notifyIndexPresence()
    const remaining = [...this.room.getConnections()].filter(c => c.id !== conn.id)
    if (remaining.length > 0) return
    // Last listener left — liveUntil already encodes the correct expiry time,
    // but if the queue is empty there's nothing to expire so clear it now.
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length === 0) {
      await this.notifyIndex(0)
    }
  }

  async onMessage(raw: string, sender: Party.Connection) {
    try {
      const msg = JSON.parse(raw)
      if (this.room.id === "index") {
        await this.handleIndex(msg)
      } else {
        await this.handleStation(msg, sender)
      }
    } catch (err) {
      sender.send(json({ type: "error", message: String(err) }))
    }
  }

  /** Receive live-status pings from station rooms */
  async onRequest(req: Party.Request): Promise<Response> {
    if (this.room.id === "index" && req.method === "POST") {
      const msg = await req.json() as any
      if (msg.type === "station_status") {
        const stations = await this.storage<StationMeta[]>("stations", [])
        const idx = stations.findIndex(s => s.id === msg.id)
        if (idx >= 0) {
          stations[idx] = {
            ...stations[idx],
            liveUntil: msg.liveUntil ?? 0,
            nowPlayingAddedBy: msg.nowPlayingAddedBy ?? undefined,
          }
          await this.room.storage.put("stations", stations)
          this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
        }
      } else if (msg.type === "station_presence") {
        this.presenceMap.set(msg.id, msg.listeners ?? [])
        const stations = await this.storage<StationMeta[]>("stations", [])
        this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
      }
    }
    return new Response("ok")
  }

  // ─── Index room ─────────────────────────────────────────────────────────

  private async handleIndex(msg: any) {
    if (msg.type === "remove_station") {
      let stations = await this.storage<StationMeta[]>("stations", [])
      stations = stations.filter(s => s.id !== msg.id)
      await this.room.storage.put("stations", stations)
      this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
      return
    }
    if (msg.type !== "register") return

    const stations = await this.storage<StationMeta[]>("stations", [])
    const idx = stations.findIndex(s => s.id === msg.id)
    const existing = idx >= 0 ? stations[idx] : null
    const meta: StationMeta = {
      id: msg.id,
      displayName: msg.displayName,
      storefront: msg.storefront,
      liveUntil: existing?.liveUntil ?? 0,
    }

    if (idx >= 0) stations[idx] = meta
    else stations.push(meta)

    await this.room.storage.put("stations", stations)
    this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
  }

  // ─── Station room ────────────────────────────────────────────────────────

  private async handleStation(msg: any, sender: Party.Connection) {
    switch (msg.type) {
      case "join":
        this.connListeners.set(sender.id, { userId: msg.userId, displayName: msg.displayName })
        void this.notifyIndexPresence()
        return
      case "add_track":        return this.addTrack(msg.track, msg.addedBy)
      case "remove_track":     return this.removeTrack(msg.key)
      case "skip_track":       return this.skipTrack()
      case "expire_track":     return this.expireTrack(msg.key, msg.addToPool)
      case "remove_from_pool": return this.removeFromPool(msg.isrc)
      case "clear_pool":       return this.clearPool()
      case "robot_dj":         return this.robotDJ()
    }
  }

  private async addTrack(track: Track, addedBy: string) {
    const queue = await this.storage<QueueItem[]>("queue", [])
    const last = queue[queue.length - 1]
    const expirationTime = last
      ? last.expirationTime + track.durationMs
      : Date.now() + track.durationMs

    queue.push({
      ...track,
      key: crypto.randomUUID(),
      expirationTime,
      addedBy,
      addedAt: Date.now()
    })

    await this.room.storage.put("queue", queue)
    this.broadcastQueue(queue)
  }

  private async removeTrack(key: string) {
    let queue = await this.storage<QueueItem[]>("queue", [])
    queue = queue.filter(i => i.key !== key)
    await this.room.storage.put("queue", queue)
    this.broadcastQueue(queue)
  }

  private async skipTrack() {
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length === 0) return

    const [, ...rest] = queue
    let cursor = Date.now()
    const newQueue = rest.map(item => {
      cursor += item.durationMs
      return { ...item, expirationTime: cursor }
    })

    await this.room.storage.put("queue", newQueue)
    this.broadcastQueue(newQueue)

    if (newQueue.length === 0) {
      await this.robotDJ()
    } else if (newQueue.length === 1 && newQueue[0].addedBy === "robot") {
      await this.addRobotTrack(newQueue.map(i => i.isrc))
    }
  }

  private async expireTrack(key: string, addToPool: boolean) {
    let queue = await this.storage<QueueItem[]>("queue", [])
    if (!queue[0] || queue[0].key !== key) return  // stale message

    const expired = queue[0]
    queue = queue.slice(1)
    await this.room.storage.put("queue", queue)

    if (addToPool) {
      const { key: _k, expirationTime: _e, addedBy: _a, addedAt: _t, ...trackData } = expired
      let pool = await this.storage<PoolTrack[]>("pool", [])
      pool = [
        { ...trackData, lastPlayedAt: Date.now() },
        ...pool.filter(t => t.isrc !== trackData.isrc)
      ].slice(0, 250)
      await this.room.storage.put("pool", pool)
      this.room.broadcast(json({ type: "pool_update", pool }))
    }

    this.broadcastQueue(queue)

    console.log(`[expireTrack] queue length: ${queue.length}, first addedBy: "${queue[0]?.addedBy}"`)
    if (queue.length === 1 && queue[0].addedBy === "robot") {
      console.log("[expireTrack] adding follow-up robot track")
      await this.addRobotTrack(queue.map(i => i.isrc))
    }
  }

  private async removeFromPool(isrc: string) {
    let pool = await this.storage<PoolTrack[]>("pool", [])
    pool = pool.filter(t => t.isrc !== isrc)
    await this.room.storage.put("pool", pool)
    this.room.broadcast(json({ type: "pool_update", pool }))
  }

  private async clearPool() {
    await this.room.storage.put("pool", [])
    this.room.broadcast(json({ type: "pool_update", pool: [] }))
  }

  private hasListeners(): boolean {
    return [...this.room.getConnections()].length > 0
  }

  private async robotDJ() {
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length > 0) return
    if (!this.hasListeners()) return

    const pool = (await this.storage<PoolTrack[]>("pool", [])).filter(hasAnyPlatformId)
    if (pool.length === 0) return

    const first = pool[Math.floor(Math.random() * pool.length)]
    const { lastPlayedAt: _1, ...track1 } = first
    await this.addTrack(track1, "robot")
    await this.addRobotTrack([first.isrc])
  }

  private async addRobotTrack(excludeIsrcs: string[]) {
    if (!this.hasListeners()) return
    const pool = await this.storage<PoolTrack[]>("pool", [])
    const candidates = pool.filter(t => hasAnyPlatformId(t) && !excludeIsrcs.includes(t.isrc))
    if (candidates.length === 0) return
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    const { lastPlayedAt: _, ...track } = pick
    await this.addTrack(track, "robot")
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Expire all past-due tracks from the queue in one pass, returning clean state. */
  private async flushExpired(): Promise<{ queue: QueueItem[], pool: PoolTrack[] }> {
    let queue = await this.storage<QueueItem[]>("queue", [])
    let pool = await this.storage<PoolTrack[]>("pool", [])
    const now = Date.now()
    let changed = false

    while (queue.length > 0 && now >= queue[0].expirationTime) {
      const { key: _k, expirationTime: _e, addedBy: _a, addedAt: _t, ...trackData } = queue[0]
      queue = queue.slice(1)
      pool = [{ ...trackData, lastPlayedAt: now }, ...pool.filter(t => t.isrc !== trackData.isrc)].slice(0, 250)
      changed = true
    }

    if (changed) {
      await this.room.storage.put("queue", queue)
      await this.room.storage.put("pool", pool)
      // Notify any already-connected clients of the cleaned-up state
      this.room.broadcast(json({ type: "queue_update", queue }))
      this.room.broadcast(json({ type: "pool_update", pool }))
    }

    return { queue, pool }
  }

  private async notifyIndexPresence() {
    const listeners = [...this.connListeners.values()]
    try {
      const indexRoom = this.room.context.parties.main.get("index")
      await indexRoom.fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "station_presence", id: this.room.id, listeners }),
      })
    } catch (e) {
      console.error("[notifyIndexPresence] failed", e)
    }
  }

  // Index room only — merges ephemeral presence into station list before broadcasting
  private withPresence(stations: StationMeta[]): StationMeta[] {
    return stations.map(s => ({ ...s, listeners: this.presenceMap.get(s.id) ?? [] }))
  }

  private async notifyIndex(liveUntil: number, nowPlayingAddedBy?: string) {
    try {
      const indexRoom = this.room.context.parties.main.get("index")
      await indexRoom.fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "station_status", id: this.room.id, liveUntil, nowPlayingAddedBy }),
      })
    } catch (e) {
      console.error("[notifyIndex] failed", e)
    }
  }

  private async storage<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.room.storage.get<any>(key)
    if (raw == null) return fallback
    if (key === "queue" || key === "pool") {
      return (raw as any[]).filter(Boolean).map(migrateTrack) as unknown as T
    }
    return raw as T
  }

  private broadcastQueue(queue: QueueItem[]) {
    this.room.broadcast(json({ type: "queue_update", queue }))
    void this.notifyIndex(liveUntilFromQueue(queue), queue[0]?.addedBy)
    if (queue.length > 0) {
      void this.room.storage.setAlarm(queue[0].expirationTime)
    }
  }
}

function liveUntilFromQueue(queue: QueueItem[]): number {
  return queue.length > 0 ? queue[queue.length - 1].expirationTime : 0
}

function json(data: object): string {
  return JSON.stringify(data)
}

function hasAnyPlatformId(t: { platformIds: PlatformIds }): boolean {
  return !!(t.platformIds?.apple || t.platformIds?.spotify)
}

// Migrate old catalogId-based track shape to the new platformIds shape.
// Runs transparently on every queue/pool read until all stored data is updated.
function migrateTrack(item: any): any {
  if (item.platformIds) return item  // already new shape
  const { catalogId, isrc, ...rest } = item
  return {
    ...rest,
    isrc: isrc ?? "",
    platformIds: { apple: catalogId },
    addedViaPlatform: "apple",
  }
}
