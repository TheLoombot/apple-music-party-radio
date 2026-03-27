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
 *   Tracks connection count; notifies index room when going live/offline.
 */
import type * as Party from "partykit/server"

// ─── Shared types (mirrored from client/src/types.ts) ────────────────────────

interface Track {
  catalogId: string
  isrc: string
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

interface StationMeta {
  id: string
  displayName: string
  storefront: string
  isLive: boolean
}

// ─── Server ───────────────────────────────────────────────────────────────────

export default class RadioParty implements Party.Server {
  private connectionCount = 0

  constructor(readonly room: Party.Room) {}

  /** Send current state to a newly connected client */
  async onConnect(conn: Party.Connection) {
    if (this.room.id === "index") {
      const stations = await this.storage<StationMeta[]>("stations", [])
      conn.send(json({ type: "stations_update", stations }))
    } else {
      this.connectionCount++
      if (this.connectionCount === 1) {
        await this.notifyIndex(true)
      }
      const queue = await this.storage<QueueItem[]>("queue", [])
      const pool = await this.storage<PoolTrack[]>("pool", [])
      conn.send(json({ type: "state", queue, pool }))
    }
  }

  async onClose(_conn: Party.Connection) {
    if (this.room.id !== "index") {
      this.connectionCount = Math.max(0, this.connectionCount - 1)
      if (this.connectionCount === 0) {
        await this.notifyIndex(false)
      }
    }
  }

  async onMessage(raw: string, sender: Party.Connection) {
    try {
      const msg = JSON.parse(raw)
      if (this.room.id === "index") {
        await this.handleIndex(msg)
      } else {
        await this.handleStation(msg)
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
          stations[idx] = { ...stations[idx], isLive: msg.isLive }
          await this.room.storage.put("stations", stations)
          this.room.broadcast(json({ type: "stations_update", stations }))
        }
      }
    }
    return new Response("ok")
  }

  // ─── Index room ─────────────────────────────────────────────────────────

  private async handleIndex(msg: any) {
    if (msg.type !== "register") return

    const stations = await this.storage<StationMeta[]>("stations", [])
    const idx = stations.findIndex(s => s.id === msg.id)
    const existing = idx >= 0 ? stations[idx] : null
    const meta: StationMeta = {
      id: msg.id,
      displayName: msg.displayName,
      storefront: msg.storefront,
      isLive: existing?.isLive ?? false,
    }

    if (idx >= 0) stations[idx] = meta
    else stations.push(meta)

    await this.room.storage.put("stations", stations)
    this.room.broadcast(json({ type: "stations_update", stations }))
  }

  // ─── Station room ────────────────────────────────────────────────────────

  private async handleStation(msg: any) {
    switch (msg.type) {
      case "add_track":    return this.addTrack(msg.track, msg.addedBy)
      case "remove_track": return this.removeTrack(msg.key)
      case "skip_track":   return this.skipTrack()
      case "expire_track":     return this.expireTrack(msg.key, msg.addToPool)
      case "remove_from_pool": return this.removeFromPool(msg.catalogId)
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
      await this.addRobotTrack(newQueue.map(i => i.catalogId))
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
        ...pool.filter(t => t.catalogId !== trackData.catalogId)
      ].slice(0, 250)
      await this.room.storage.put("pool", pool)
      this.room.broadcast(json({ type: "pool_update", pool }))
    }

    this.broadcastQueue(queue)

    console.log(`[expireTrack] queue length: ${queue.length}, first addedBy: "${queue[0]?.addedBy}"`)
    if (queue.length === 1 && queue[0].addedBy === "robot") {
      console.log("[expireTrack] adding follow-up robot track")
      await this.addRobotTrack(queue.map(i => i.catalogId))
    }
  }

  private async removeFromPool(catalogId: string) {
    let pool = await this.storage<PoolTrack[]>("pool", [])
    pool = pool.filter(t => t.catalogId !== catalogId)
    await this.room.storage.put("pool", pool)
    this.room.broadcast(json({ type: "pool_update", pool }))
  }

  private async clearPool() {
    await this.room.storage.put("pool", [])
    this.room.broadcast(json({ type: "pool_update", pool: [] }))
  }

  private async robotDJ() {
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length > 0) return

    const pool = (await this.storage<PoolTrack[]>("pool", [])).filter(isCatalogId)
    if (pool.length === 0) return

    const first = pool[Math.floor(Math.random() * pool.length)]
    const { lastPlayedAt: _1, ...track1 } = first
    await this.addTrack(track1, "robot")

    await this.addRobotTrack([first.catalogId])
  }

  private async addRobotTrack(excludeCatalogIds: string[]) {
    const pool = await this.storage<PoolTrack[]>("pool", [])
    const candidates = pool.filter(t => isCatalogId(t) && !excludeCatalogIds.includes(t.catalogId))
    if (candidates.length === 0) return
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    const { lastPlayedAt: _, ...track } = pick
    await this.addTrack(track, "robot")
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async notifyIndex(isLive: boolean) {
    try {
      const indexRoom = this.room.context.parties.main.get("index")
      await indexRoom.fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "station_status", id: this.room.id, isLive }),
      })
    } catch (e) {
      console.error("[notifyIndex] failed", e)
    }
  }

  private async storage<T>(key: string, fallback: T): Promise<T> {
    return (await this.room.storage.get<T>(key)) ?? fallback
  }

  private broadcastQueue(queue: QueueItem[]) {
    this.room.broadcast(json({ type: "queue_update", queue }))
  }
}

function json(data: object): string {
  return JSON.stringify(data)
}

function isCatalogId(t: { catalogId: string }): boolean {
  return /^\d+$/.test(t.catalogId)
}
