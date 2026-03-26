/**
 * Apple Music Party Radio — PartyKit server
 *
 * Runs on Cloudflare Durable Objects via PartyKit.
 * Each radio station is a separate room identified by the owner's user ID.
 * A special "index" room maintains the list of all registered stations.
 *
 * Room: "index"
 *   Handles station registration and discovery.
 *
 * Room: "{userId}"
 *   Handles the queue, song pool, and all playback state for one station.
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
}

// ─── Server ───────────────────────────────────────────────────────────────────

export default class RadioParty implements Party.Server {
  constructor(readonly room: Party.Room) {}

  /** Send current state to a newly connected client */
  async onConnect(conn: Party.Connection) {
    if (this.room.id === "index") {
      const stations = await this.storage<StationMeta[]>("stations", [])
      conn.send(json({ type: "stations_update", stations }))
    } else {
      const queue = await this.storage<QueueItem[]>("queue", [])
      const pool = await this.storage<PoolTrack[]>("pool", [])
      conn.send(json({ type: "state", queue, pool }))
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

  // ─── Index room ─────────────────────────────────────────────────────────

  private async handleIndex(msg: any) {
    if (msg.type !== "register") return

    const stations = await this.storage<StationMeta[]>("stations", [])
    const idx = stations.findIndex(s => s.id === msg.id)
    const meta: StationMeta = { id: msg.id, displayName: msg.displayName, storefront: msg.storefront }

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
      // Remove any existing entry for this track, then prepend the fresh one
      pool = [
        { ...trackData, lastPlayedAt: Date.now() },
        ...pool.filter(t => t.catalogId !== trackData.catalogId)
      ].slice(0, 250)
      await this.room.storage.put("pool", pool)
      this.room.broadcast(json({ type: "pool_update", pool }))
    }

    this.broadcastQueue(queue)

    // If the track now playing was queued by Robot DJ and nothing follows it,
    // add another robot track so there's always something coming up.
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
    if (queue.length > 0) return  // someone else already added a track

    const pool = (await this.storage<PoolTrack[]>("pool", [])).filter(isCatalogId)
    if (pool.length === 0) return

    // Pick first track, then a second that's different
    const first = pool[Math.floor(Math.random() * pool.length)]
    const { lastPlayedAt: _1, ...track1 } = first
    await this.addTrack(track1, "robot")

    await this.addRobotTrack([first.catalogId])
  }

  // Pick a random pool track not already in the given exclusion list and add it.
  private async addRobotTrack(excludeCatalogIds: string[]) {
    const pool = await this.storage<PoolTrack[]>("pool", [])
    const candidates = pool.filter(t => isCatalogId(t) && !excludeCatalogIds.includes(t.catalogId))
    if (candidates.length === 0) return
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    const { lastPlayedAt: _, ...track } = pick
    await this.addTrack(track, "robot")
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

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
