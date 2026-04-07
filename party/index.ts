/**
 * Apple Music Party Radio — PartyKit server
 *
 * Runs on Cloudflare Durable Objects via PartyKit.
 * Each radio station is a separate room identified by a human-readable slug
 * chosen at creation time. A special "index" room maintains the list of all
 * registered stations.
 *
 * Room: "index"
 *   Handles station registration, discovery, and slug uniqueness checks.
 *   Receives live-status pings from station rooms via HTTP POST.
 *
 * Room: "{slug}"
 *   Handles the queue, song pool, and all playback state for one station.
 *   Ownership is stored persistently under the "ownership" storage key.
 *
 * Legacy rooms: rooms where id === ownerUid (old 1:1 model) are auto-migrated
 *   on first join — ownership is bootstrapped lazily.
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
  addedByName?: string   // display name resolved server-side from connListeners
  addedAt: number
}

interface PoolTrack extends Track {
  lastPlayedAt: number
  addedByUsers: string[]
  playCount: number
}

interface ChatMessage {
  id: string
  userId: string
  displayName: string
  text: string
  sentAt: number
}

interface Listener {
  userId: string
  displayName: string
}

interface ConnectedListener extends Listener {
  isDJ: boolean
}

interface StationMeta {
  id: string
  displayName: string
  storefront: string
  liveUntil: number   // Unix ms; 0 = not live; client computes isLive as liveUntil > Date.now()
  ownerUid?: string   // stored at creation time; undefined for legacy rooms until migrated
  nowPlayingAddedBy?: string
  nowPlayingAddedByName?: string
  nowPlayingTrackName?: string
  nowPlayingArtistName?: string
  listeners?: Listener[]
}

interface StationOwnership {
  ownerUid: string
  createdAt: number
}

// ─── Server ───────────────────────────────────────────────────────────────────

export default class RadioParty implements Party.Server {
  constructor(readonly room: Party.Room) {}

  // Station rooms: connId → listener info (ephemeral, not persisted)
  private connListeners = new Map<string, ConnectedListener>()

  // Index room: stationId → listener list (ephemeral, not persisted)
  private presenceMap = new Map<string, Listener[]>()

  // Ownership + DJ cache — populated lazily from storage (not guaranteed to survive DO hibernation)
  private cachedOwnerUid: string | null = null
  private cachedDJs: string[] | null = null  // array of userId strings

  // room.id is inaccessible in onAlarm (PartyKit limitation). We cache it and
  // persist it to storage so the alarm handler can recover it after hibernation.
  private cachedRoomId: string | null = null

  private getRoomId(): string {
    return this.cachedRoomId ?? this.room.id
  }

  /** Send current state to a newly connected client */
  async onConnect(conn: Party.Connection) {
    this.cachedRoomId = this.room.id
    if (this.room.id === "index") {
      const stations = await this.storage<StationMeta[]>("stations", [])
      conn.send(json({ type: "stations_update", stations: this.withPresence(stations) }))
    } else {
      const { queue, pool } = await this.flushExpired()
      const chat = await this.storage<ChatMessage[]>("chat", [])
      const djs = await this.getDJs()
      conn.send(json({ type: "state", queue, pool, chat, djs }))
      // Sync live status to index on every connect so stale flags get corrected
      void this.notifyIndex(liveUntilFromQueue(queue), queue[0]?.addedBy, queue[0]?.addedByName, queue[0]?.name, queue[0]?.artistName)
      // Re-arm expiration alarm in case the DO restarted and lost it
      if (queue.length > 0) {
        void this.room.storage.setAlarm(queue[0].expirationTime)
      }
    }
  }

  async onAlarm() {
    // room.id is inaccessible in onAlarm — restore from storage
    if (!this.cachedRoomId) {
      this.cachedRoomId = await this.room.storage.get<string>("roomId") ?? null
    }
    if (!this.cachedRoomId || this.cachedRoomId === "index") return
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length === 0) return
    if (Date.now() >= queue[0].expirationTime) {
      await this.expireTrack(queue[0].key, true)
    }
  }

  async onClose(conn: Party.Connection) {
    if (this.getRoomId() === "index") return
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
      if (this.getRoomId() === "index") {
        await this.handleIndex(msg)
      } else {
        await this.handleStation(msg, sender)
      }
    } catch (err) {
      sender.send(json({ type: "error", message: String(err) }))
    }
  }

  async onRequest(req: Party.Request): Promise<Response> {
    const url = new URL(req.url)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    if (this.getRoomId() === "index") {
      // GET /parties/main/index?check=<slug> — slug availability check
      if (req.method === "GET") {
        const checkSlug = url.searchParams.get("check")
        if (checkSlug) {
          const stations = await this.storage<StationMeta[]>("stations", [])
          const taken = stations.some(s => s.id === checkSlug)
          return new Response(JSON.stringify({ taken }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }
      }

      // POST /parties/main/index — station status/presence pings from station rooms
      if (req.method === "POST") {
        const msg = await req.json() as any
        if (msg.type === "station_status") {
          const stations = await this.storage<StationMeta[]>("stations", [])
          const idx = stations.findIndex(s => s.id === msg.id)
          if (idx >= 0) {
            stations[idx] = {
              ...stations[idx],
              liveUntil: msg.liveUntil ?? 0,
              nowPlayingAddedBy: msg.nowPlayingAddedBy ?? undefined,
              nowPlayingAddedByName: msg.nowPlayingAddedByName ?? undefined,
              nowPlayingTrackName: msg.nowPlayingTrackName ?? stations[idx].nowPlayingTrackName,
              nowPlayingArtistName: msg.nowPlayingArtistName ?? stations[idx].nowPlayingArtistName,
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
    } else {
      // POST /parties/main/<slug>/create — station creation endpoint
      if (req.method === "POST" && url.pathname.endsWith("/create")) {
        const existing = await this.room.storage.get<StationOwnership>("ownership")
        if (existing) {
          return new Response("taken", { status: 409, headers: corsHeaders })
        }
        const body = await req.json() as { ownerUid: string; displayName: string; storefront: string }
        const ownership: StationOwnership = { ownerUid: body.ownerUid, createdAt: Date.now() }
        await this.room.storage.put("ownership", ownership)
        this.cachedOwnerUid = body.ownerUid
        return new Response("ok", { headers: corsHeaders })
      }
    }

    return new Response("ok", { headers: corsHeaders })
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
      ...existing,
      id: msg.id,
      displayName: msg.displayName,
      storefront: msg.storefront,
      liveUntil: existing?.liveUntil ?? 0,
      ownerUid: msg.ownerUid ?? existing?.ownerUid,
    }

    if (idx >= 0) stations[idx] = meta
    else stations.push(meta)

    await this.room.storage.put("stations", stations)
    this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
  }

  // ─── Station room ────────────────────────────────────────────────────────

  private async handleStation(msg: any, sender: Party.Connection) {
    switch (msg.type) {
      case "join": {
        const djs = await this.getDJs()
        const isDJ = djs.includes(msg.userId)
        this.connListeners.set(sender.id, { userId: msg.userId, displayName: msg.displayName, isDJ })
        void this.notifyIndexPresence()
        // Send current DJ list to the joining client
        sender.send(json({ type: "dj_update", djs }))
        // Legacy migration: if this room has no stored ownership and the room ID
        // equals the joining user's UID (old 1:1 model), bootstrap ownership now.
        const ownerUid = await this.getOwnerUid()
        if (!ownerUid && msg.userId === this.room.id) {
          const ownership: StationOwnership = { ownerUid: msg.userId, createdAt: Date.now() }
          await this.room.storage.put("ownership", ownership)
          this.cachedOwnerUid = msg.userId
        }
        return
      }
      case "grant_dj": {
        if (!this.isOwnerConn(sender)) return
        const djs = await this.getDJs()
        if (!djs.includes(msg.userId)) {
          const updated = [...djs, msg.userId]
          await this.room.storage.put("djs", updated)
          this.cachedDJs = updated
          // Update in-memory flag for any active connections with this userId
          for (const [id, l] of this.connListeners) {
            if (l.userId === msg.userId) this.connListeners.set(id, { ...l, isDJ: true })
          }
          this.room.broadcast(json({ type: "dj_update", djs: updated }))
        }
        return
      }
      case "revoke_dj": {
        if (!this.isOwnerConn(sender)) return
        const djs = await this.getDJs()
        const updated = djs.filter(id => id !== msg.userId)
        await this.room.storage.put("djs", updated)
        this.cachedDJs = updated
        for (const [id, l] of this.connListeners) {
          if (l.userId === msg.userId) this.connListeners.set(id, { ...l, isDJ: false })
        }
        this.room.broadcast(json({ type: "dj_update", djs: updated }))
        return
      }
      case "add_track": {
        const addedByName = this.connListeners.get(sender.id)?.displayName
        return this.addTrack(msg.track, msg.addedBy, addedByName)
      }
      case "remove_track":     return this.removeTrack(msg.key)
      case "skip_track":       return this.skipTrack()
      case "expire_track":     return this.expireTrack(msg.key, msg.addToPool)
      case "remove_from_pool": return this.removeFromPool(msg.isrc)
      case "clear_pool":       return this.clearPool()
      case "robot_dj":         return this.robotDJ()
      case "reorder_queue":    return this.reorderQueue(msg.keys)
      case "chat_message":     return this.handleChatMessage(msg, sender)
    }
  }

  // ─── Ownership + DJ helpers ──────────────────────────────────────────────

  private async getOwnerUid(): Promise<string | null> {
    if (!this.cachedOwnerUid) {
      const o = await this.room.storage.get<StationOwnership>("ownership")
      this.cachedOwnerUid = o?.ownerUid ?? null
    }
    return this.cachedOwnerUid
  }

  private async getDJs(): Promise<string[]> {
    if (!this.cachedDJs) {
      this.cachedDJs = await this.room.storage.get<string[]>("djs") ?? []
    }
    return this.cachedDJs
  }

  private isOwnerConn(sender: Party.Connection): boolean {
    const listener = this.connListeners.get(sender.id)
    return !!listener && listener.userId === this.cachedOwnerUid
  }

  private isDJConn(sender: Party.Connection): boolean {
    return this.connListeners.get(sender.id)?.isDJ === true
  }

  // ─── Queue & pool ────────────────────────────────────────────────────────

  private async addTrack(track: Track, addedBy: string, addedByName?: string) {
    const queue = await this.storage<QueueItem[]>("queue", [])
    const last = queue[queue.length - 1]
    const expirationTime = last
      ? last.expirationTime + track.durationMs
      : Date.now() + track.durationMs

    queue.push({
      ...track,
      key: crypto.randomUUID(),
      expirationTime,
      addedByName,
      addedBy,
      addedAt: Date.now()
    })

    await this.room.storage.put("queue", queue)
    await this.broadcastQueue(queue)
  }

  private async removeTrack(key: string) {
    let queue = await this.storage<QueueItem[]>("queue", [])
    queue = queue.filter(i => i.key !== key)
    await this.room.storage.put("queue", queue)
    await this.broadcastQueue(queue)
  }

  private async reorderQueue(keys: string[]) {
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length <= 1) return
    const nowPlaying = queue[0]
    const rest = queue.slice(1)
    const keySet = new Set(keys)
    const reordered = keys.map(k => rest.find(i => i.key === k)).filter((i): i is QueueItem => i != null)
    const missing = rest.filter(i => !keySet.has(i.key))
    let cursor = nowPlaying.expirationTime
    const newUpNext = [...reordered, ...missing].map(item => {
      cursor += item.durationMs
      return { ...item, expirationTime: cursor }
    })
    const newQueue = [nowPlaying, ...newUpNext]
    await this.room.storage.put("queue", newQueue)
    await this.broadcastQueue(newQueue)
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
    await this.broadcastQueue(newQueue)

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
      const { key: _k, expirationTime: _e, addedBy, addedAt: _t, ...trackData } = expired
      let pool = await this.storage<PoolTrack[]>("pool", [])
      const existing = pool.find(t => t.isrc === trackData.isrc)
      const prevUsers = existing?.addedByUsers ?? []
      const addedByUsers = addedBy && addedBy !== "robot"
        ? [...new Set([...prevUsers, addedBy])]
        : prevUsers
      pool = [
        { ...trackData, lastPlayedAt: Date.now(), addedByUsers, playCount: (existing?.playCount ?? 0) + 1 },
        ...pool.filter(t => t.isrc !== trackData.isrc)
      ].slice(0, 100)
      await this.room.storage.put("pool", pool)
      this.room.broadcast(json({ type: "pool_update", pool }))
    }

    await this.broadcastQueue(queue)

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

  private async handleChatMessage(msg: any, sender: Party.Connection) {
    const text = (msg.text ?? "").trim().slice(0, 500)
    if (!text) return
    const listener = this.connListeners.get(sender.id)
    if (!listener) return
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      userId: listener.userId,
      displayName: listener.displayName,
      text,
      sentAt: Date.now(),
    }
    let chat = await this.storage<ChatMessage[]>("chat", [])
    chat = [...chat, message].slice(-100)
    await this.room.storage.put("chat", chat)
    // Broadcast to all other connections; send explicitly to sender
    this.room.broadcast(json({ type: "chat_message", message }), [sender.id])
    sender.send(json({ type: "chat_message", message }))
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
    const { lastPlayedAt: _1, addedByUsers: _2, playCount: _3, ...track1 } = first
    await this.addTrack(track1, "robot")
    await this.addRobotTrack([first.isrc])
  }

  private async addRobotTrack(excludeIsrcs: string[]) {
    if (!this.hasListeners()) return
    const pool = await this.storage<PoolTrack[]>("pool", [])
    const candidates = pool.filter(t => hasAnyPlatformId(t) && !excludeIsrcs.includes(t.isrc))
    if (candidates.length === 0) return
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    const { lastPlayedAt: _, addedByUsers: _2, playCount: _3, ...track } = pick
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
      const { key: _k, expirationTime: _e, addedBy, addedAt: _t, ...trackData } = queue[0]
      queue = queue.slice(1)
      const existing = pool.find(t => t.isrc === trackData.isrc)
      const prevUsers = existing?.addedByUsers ?? []
      const addedByUsers = addedBy && addedBy !== "robot"
        ? [...new Set([...prevUsers, addedBy])]
        : prevUsers
      pool = [{ ...trackData, lastPlayedAt: now, addedByUsers, playCount: (existing?.playCount ?? 0) + 1 }, ...pool.filter(t => t.isrc !== trackData.isrc)].slice(0, 100)
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

  // Derive the index room's HTTP URL from env (set in partykit.json) or localhost fallback.
  // Using plain fetch instead of room.context.parties avoids the onAlarm restriction.
  private getIndexUrl(): string {
    const host = (this.room.env as any)?.PARTYKIT_HOST ?? "localhost:1999"
    const protocol = host.startsWith("localhost") ? "http" : "https"
    return `${protocol}://${host}/parties/main/index`
  }

  private async notifyIndexPresence() {
    const listeners: Listener[] = [...this.connListeners.values()].map(({ userId, displayName }) => ({ userId, displayName }))
    try {
      await fetch(this.getIndexUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "station_presence", id: this.getRoomId(), listeners }),
      })
    } catch (e) {
      console.error("[notifyIndexPresence] failed", e)
    }
  }

  // Index room only — merges ephemeral presence into station list before broadcasting
  private withPresence(stations: StationMeta[]): StationMeta[] {
    return stations.map(s => ({ ...s, listeners: this.presenceMap.get(s.id) ?? [] }))
  }

  private async notifyIndex(liveUntil: number, nowPlayingAddedBy?: string, nowPlayingAddedByName?: string, nowPlayingTrackName?: string, nowPlayingArtistName?: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fetch(this.getIndexUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "station_status", id: this.getRoomId(), liveUntil, nowPlayingAddedBy, nowPlayingAddedByName, nowPlayingTrackName, nowPlayingArtistName }),
        })
        return
      } catch (e) {
        if (attempt === 2) console.error("[notifyIndex] failed after 3 attempts", e)
      }
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

  private async broadcastQueue(queue: QueueItem[]) {
    this.room.broadcast(json({ type: "queue_update", queue }))
    await this.notifyIndex(liveUntilFromQueue(queue), queue[0]?.addedBy, queue[0]?.addedByName, queue[0]?.name, queue[0]?.artistName)
    if (queue.length > 0) {
      // Persist room ID alongside the alarm so onAlarm can recover it after hibernation
      await this.room.storage.put("roomId", this.getRoomId())
      await this.room.storage.setAlarm(queue[0].expirationTime)
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
  if (item.platformIds) {
    // Backfill fields for pool tracks that predate them
    if ('lastPlayedAt' in item) {
      return {
        ...item,
        addedByUsers: item.addedByUsers ?? [],
        playCount: item.playCount ?? 1,
      }
    }
    return item
  }
  const { catalogId, isrc, ...rest } = item
  return {
    ...rest,
    isrc: isrc ?? "",
    platformIds: { apple: catalogId },
    addedViaPlatform: "apple",
  }
}
