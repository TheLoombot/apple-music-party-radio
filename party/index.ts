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

type Platform = "apple" | "spotify"

interface PlatformIds {
  apple?: string
  spotify?: string
}

interface Track {
  isrc: string
  platformIds: PlatformIds
  addedViaPlatform: Platform
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
  isDJ?: boolean
}

interface ConnectedListener extends Listener {
  isDJ: boolean
  lastMessageAt?: number  // for per-connection chat rate limiting
}

interface Station {
  id: string
  displayName: string
  storefront: string
  liveUntil: number   // Unix ms; 0 = not live; client computes isLive as liveUntil > Date.now()
  ownerUid?: string   // stored at creation time; undefined for legacy rooms until migrated
  nowPlayingAddedBy?: string
  nowPlayingAddedByName?: string
  nowPlayingTrackName?: string
  nowPlayingArtistName?: string
  nowPlayingArtworkUrl?: string
  listeners?: Listener[]
}

interface StationOwnership {
  ownerUid: string
  createdAt: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** How many robot-queued tracks to maintain in the tail of the queue at all times. */
const TARGET_ROBOT_DEPTH = 8

/** Max tracks a single non-robot user may have queued at once (prevents queue flooding). */
const MAX_USER_QUEUE_DEPTH = 5

/** Min milliseconds between chat messages per connection (prevents chat flooding). */
const CHAT_RATE_LIMIT_MS = 1000

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

  // Index URL — derived from conn.uri on first connect, persisted to storage so
  // the alarm handler (where room.env may be inaccessible) can recover it.
  private cachedIndexUrl: string | null = null

  // Guard against concurrent fillRobotQueue calls (e.g. rapid skips)
  private robotFilling = false

  // Debounce timer for presence notifications only (join/leave coalescing)
  private presenceTimer: ReturnType<typeof setTimeout> | null = null

  private getRoomId(): string {
    return this.cachedRoomId ?? this.room.id
  }

  /** Send current state to a newly connected client */
  async onConnect(conn: Party.Connection) {
    this.cachedRoomId = this.room.id
    // Persist roomId on every connect so onAlarm can always recover it after DO hibernation.
    // broadcastQueue also does this, but onConnect covers stations that have never had queue activity.
    if (this.room.id !== "index") {
      await this.room.storage.put("roomId", this.room.id)
    }
    // Derive and persist the index URL from the connection's WebSocket URL so it
    // survives DO hibernation (where room.env is inaccessible in onAlarm).
    if (!this.cachedIndexUrl && this.room.id !== "index") {
      try {
        const wsUrl = new URL(conn.uri)
        const isSecure = wsUrl.protocol === "wss:"
        const protocol = isSecure ? "https" : "http"
        // In local dev (non-secure), always use localhost so server-side fetches
        // to the index room resolve correctly regardless of the browser's hostname
        // (e.g. http://imac:1999 won't resolve from within Node.js).
        const host = isSecure ? wsUrl.host : `localhost:${wsUrl.port || "1999"}`
        const indexUrl = `${protocol}://${host}/parties/main/index`
        this.cachedIndexUrl = indexUrl
        await this.room.storage.put("indexUrl", indexUrl)
      } catch { /* ignore — fallback to env var */ }
    }
    if (this.room.id === "index") {
      const stations = await this.storage<Station[]>("stations", [])
      conn.send(json({ type: "stations_update", stations: this.withPresence(stations) }))
    } else {
      try {
        const { queue, pool } = await this.flushExpired()
        const chat = await this.storage<ChatMessage[]>("chat", [])
        const djs = await this.getDJs()
        conn.send(json({ type: "state", queue, pool, chat, djs }))
        // Sync live status to index on every connect so stale flags get corrected
        void this.notifyIndex(liveUntilFromQueue(queue), queue[0]?.addedBy, queue[0]?.addedByName, queue[0]?.name, queue[0]?.artistName, queue[0]?.artworkUrl)
        // Re-arm expiration alarm in case the DO restarted and lost it
        if (queue.length > 0) {
          void this.room.storage.setAlarm(queue[0].expirationTime)
        }
        // Proactively top up the robot queue whenever a listener connects
        void this.fillRobotQueue()
      } catch (err) {
        console.error(`[onConnect] error for room ${this.room.id}:`, err)
        conn.send(json({ type: "state", queue: [], pool: [], chat: [], djs: [] }))
      }
    }
  }

  async onAlarm() {
    // room.id is inaccessible in onAlarm — restore from storage
    if (!this.cachedRoomId) {
      this.cachedRoomId = await this.room.storage.get<string>("roomId") ?? null
    }
    if (!this.cachedRoomId || this.cachedRoomId === "index") {
      console.warn("[onAlarm] roomId missing from storage — alarm fired but cannot proceed. Stored roomId:", this.cachedRoomId)
      return
    }
    console.log(`[onAlarm] fired for room "${this.cachedRoomId}", indexUrl cache: ${this.cachedIndexUrl ?? "(none)"}`)

    try {
      const queue = await this.storage<QueueItem[]>("queue", [])
      if (queue.length === 0) {
        // Queue empty — try to refill from pool before marking the station offline.
        // This keeps the alarm chain alive when the queue drains with no listeners present.
        await this.fillRobotQueue()
        const refilled = await this.storage<QueueItem[]>("queue", [])
        if (refilled.length === 0) {
          // Pool also empty — station genuinely has nothing to play
          await this.notifyIndex(0)
        }
        return
      }
      if (Date.now() >= queue[0].expirationTime) {
        // Flush ALL stale tracks in one pass rather than one per alarm fire.
        // If the DO was hibernated for a while, multiple tracks may have expired.
        // Expiring them one-at-a-time leaves liveUntilFromQueue pointing at a past
        // timestamp through the entire catch-up sequence, making the station look offline.
        const { queue: cleanQueue } = await this.flushExpired()
        if (cleanQueue.length > 0) {
          // Broadcast current state and arm next alarm (broadcastQueue handles both)
          await this.broadcastQueue(cleanQueue)
        }
        await this.fillRobotQueue()
        if (cleanQueue.length === 0) {
          const refilled = await this.storage<QueueItem[]>("queue", [])
          if (refilled.length === 0) await this.notifyIndex(0)
        }
      } else {
        // Alarm fired early (Cloudflare may do this) — reschedule for the correct time.
        // Without this, the track is stuck: it won't be expired by alarm and won't be added to pool.
        await this.room.storage.setAlarm(queue[0].expirationTime)
      }
    } catch (err) {
      console.error(`[onAlarm] error in room ${this.cachedRoomId}:`, err)
      // Best-effort: notify index so the station doesn't stay "live" forever on error
      try {
        const queue = await this.storage<QueueItem[]>("queue", [])
        await this.notifyIndex(
          liveUntilFromQueue(queue),
          queue[0]?.addedBy, queue[0]?.addedByName,
          queue[0]?.name, queue[0]?.artistName, queue[0]?.artworkUrl
        )
      } catch (e) {
        console.error(`[onAlarm] fallback notifyIndex also failed in room ${this.cachedRoomId}:`, e)
      }
    }
  }

  async onClose(conn: Party.Connection) {
    if (this.getRoomId() === "index") return
    this.connListeners.delete(conn.id)
    this.schedulePresenceNotify()
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
          const stations = await this.storage<Station[]>("stations", [])
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
          const stations = await this.storage<Station[]>("stations", [])
          const idx = stations.findIndex(s => s.id === msg.id)
          if (idx >= 0) {
            const liveUntil = msg.liveUntil ?? 0
            const isLive = liveUntil > 0
            stations[idx] = {
              ...stations[idx],
              liveUntil,
              nowPlayingAddedBy: msg.nowPlayingAddedBy ?? undefined,
              nowPlayingAddedByName: msg.nowPlayingAddedByName ?? undefined,
              // When the queue empties (liveUntil === 0), clear stale now-playing metadata.
              // Previously `?? stations[idx].nowPlayingTrackName` preserved old data forever,
              // so the station card kept showing the last played track even when offline.
              nowPlayingTrackName: isLive ? (msg.nowPlayingTrackName ?? stations[idx].nowPlayingTrackName) : undefined,
              nowPlayingArtistName: isLive ? (msg.nowPlayingArtistName ?? stations[idx].nowPlayingArtistName) : undefined,
              nowPlayingArtworkUrl: isLive ? (msg.nowPlayingArtworkUrl ?? stations[idx].nowPlayingArtworkUrl) : undefined,
            }
            await this.room.storage.put("stations", stations)
            this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
          } else {
            console.warn(`[station_status] unknown station "${msg.id}" — not in registry, update dropped`)
          }
        } else if (msg.type === "station_presence") {
          this.presenceMap.set(msg.id, msg.listeners ?? [])
          const stations = await this.storage<Station[]>("stations", [])
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

      // POST /parties/main/<slug>/bootstrap — wake a dormant station (sent by index on register)
      if (req.method === "POST" && url.pathname.endsWith("/bootstrap")) {
        // Persist context needed by onAlarm (normally set on first WebSocket connect).
        // Await these writes so the DO has both values in durable storage before returning —
        // if the DO hibernates immediately after this response, onAlarm can still recover them.
        this.cachedRoomId = this.room.id
        await this.room.storage.put("roomId", this.room.id)
        if (!this.cachedIndexUrl) {
          const protocol = url.protocol === "https:" ? "https" : "http"
          const indexUrl = `${protocol}://${url.host}/parties/main/index`
          this.cachedIndexUrl = indexUrl
          await this.room.storage.put("indexUrl", indexUrl)
        }
        await this.bootstrapIfNeeded()
        return new Response("ok", { headers: corsHeaders })
      }
    }

    return new Response("ok", { headers: corsHeaders })
  }

  // ─── Index room ─────────────────────────────────────────────────────────

  private async handleIndex(msg: any) {
    if (msg.type === "remove_station") {
      let stations = await this.storage<Station[]>("stations", [])
      stations = stations.filter(s => s.id !== msg.id)
      await this.room.storage.put("stations", stations)
      this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
      return
    }
    if (msg.type !== "register") return

    const stations = await this.storage<Station[]>("stations", [])
    const idx = stations.findIndex(s => s.id === msg.id)
    const existing = idx >= 0 ? stations[idx] : null
    const meta: Station = {
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

    // If the station appears offline, send it a bootstrap ping so it wakes up and
    // starts playing from its pool even with no listeners connected.
    if (!existing || existing.liveUntil <= Date.now()) {
      // Pass the full public URL so the bootstrap handler can derive the correct indexUrl from url.host
      const host = (this.room.env as any)?.PARTYKIT_HOST ?? "localhost:1999"
      const protocol = host.startsWith("localhost") ? "http" : "https"
      const bootstrapUrl = `${protocol}://${host}/parties/main/${encodeURIComponent(msg.id)}/bootstrap`
      void this.room.context.parties.main.get(msg.id).fetch(bootstrapUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch((e: unknown) => console.error(`[bootstrap] failed for station "${msg.id}":`, e))
    }
  }

  // ─── Station room ────────────────────────────────────────────────────────

  private async handleStation(msg: any, sender: Party.Connection) {
    switch (msg.type) {
      case "join": {
        const djs = await this.getDJs()
        const isDJ = djs.includes(msg.userId)
        this.connListeners.set(sender.id, { userId: msg.userId, displayName: msg.displayName, isDJ })
        this.schedulePresenceNotify()
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
        await this.addTrack(msg.track, msg.addedBy, addedByName)
        // After a user track is added, fill robot tail if it fell short
        await this.fillRobotQueue()
        return
      }
      case "remove_track":     if (!this.isPrivilegedConn(sender)) return; return this.removeTrack(msg.key)
      case "skip_track":       if (!this.isPrivilegedConn(sender)) return; return this.skipTrack()
      case "expire_track":     return this.expireTrack(msg.key, msg.addToPool)  // clients self-report their own track advance
      case "remove_from_pool": if (!this.isPrivilegedConn(sender)) return; return this.removeFromPool(msg.isrc)
      case "clear_pool":       if (!this.isPrivilegedConn(sender)) return; return this.clearPool()
      case "robot_dj":         if (!this.isPrivilegedConn(sender)) return; return this.fillRobotQueue()
      case "reorder_queue":    if (!this.isPrivilegedConn(sender)) return; return this.reorderQueue(msg.keys)
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

  /** Owner or any granted DJ — used to gate queue/pool mutations server-side. */
  private isPrivilegedConn(sender: Party.Connection): boolean {
    return this.isOwnerConn(sender) || this.isDJConn(sender)
  }

  // ─── Queue & pool ────────────────────────────────────────────────────────

  /** Index (in the queue array) at which a new user track should be inserted.
   *  User tracks always sit after existing user tracks but before any robot tail. */
  private getInsertionIndex(queue: QueueItem[]): number {
    // queue[0] is now-playing — never insert before it.
    // Walk forward from position 1 and return the index of the first robot track.
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].addedBy === "robot") return i
    }
    return queue.length  // no robot tracks yet — append at end
  }

  private async addTrack(track: Track, addedBy: string, addedByName?: string) {
    const queue = await this.storage<QueueItem[]>("queue", [])

    // Reject if this user already has too many tracks queued (excludes now-playing).
    if (addedBy !== "robot") {
      const userQueued = queue.slice(1).filter(i => i.addedBy === addedBy).length
      if (userQueued >= MAX_USER_QUEUE_DEPTH) return
    }

    // Robot tracks always append at the tail; user tracks insert before the robot tail.
    const insertAt = addedBy === "robot" ? queue.length : this.getInsertionIndex(queue)

    const predecessor = queue[insertAt - 1] ?? null
    const expirationTime = predecessor
      ? Math.max(predecessor.expirationTime, Date.now()) + track.durationMs
      : Date.now() + track.durationMs

    const newItem: QueueItem = {
      ...track,
      key: crypto.randomUUID(),
      expirationTime,
      addedByName,
      addedBy,
      addedAt: Date.now(),
    }

    queue.splice(insertAt, 0, newItem)

    // Recalculate expiration times for everything after the insertion point
    // (only needed when inserting into the middle of the queue)
    if (insertAt < queue.length - 1) {
      let cursor = newItem.expirationTime
      for (let i = insertAt + 1; i < queue.length; i++) {
        cursor += queue[i].durationMs
        queue[i] = { ...queue[i], expirationTime: cursor }
      }
    }

    await this.room.storage.put("queue", queue)
    await this.broadcastQueue(queue)
  }

  private async removeTrack(key: string) {
    let queue = await this.storage<QueueItem[]>("queue", [])
    // Removing now-playing must go through skipTrack/expireTrack so pool logic runs correctly.
    if (queue[0]?.key === key) return
    if (!queue.find(i => i.key === key)) return
    queue = queue.filter(i => i.key !== key)
    // Recalculate expiration times for all queued tracks (anchored to max(queue[0].expiry, now)
    // so stale times from DO hibernation are healed at the same time).
    if (queue.length > 1) {
      let cursor = Math.max(queue[0].expirationTime, Date.now())
      for (let i = 1; i < queue.length; i++) {
        cursor += queue[i].durationMs
        queue[i] = { ...queue[i], expirationTime: cursor }
      }
    }
    await this.room.storage.put("queue", queue)
    await this.broadcastQueue(queue)
  }

  private async reorderQueue(keys: string[]) {
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length <= 1) return
    const nowPlaying = queue[0]
    // Reorder only the user section — robot tail always stays at the end
    const userItems = queue.slice(1).filter(i => i.addedBy !== "robot")
    const robotItems = queue.slice(1).filter(i => i.addedBy === "robot")
    const keySet = new Set(keys)
    const reordered = keys.map(k => userItems.find(i => i.key === k)).filter((i): i is QueueItem => i != null)
    const missing = userItems.filter(i => !keySet.has(i.key))
    let cursor = Math.max(nowPlaying.expirationTime, Date.now())
    const newQueue = [nowPlaying, ...[...reordered, ...missing, ...robotItems].map(item => {
      cursor += item.durationMs
      return { ...item, expirationTime: cursor }
    })]
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
    await this.fillRobotQueue()
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
      const existing = pool.find(t => sameTrack(t, trackData))
      const prevUsers = existing?.addedByUsers ?? []
      const addedByUsers = addedBy && addedBy !== "robot"
        ? [...new Set([...prevUsers, addedBy])]
        : prevUsers
      pool = [
        { ...trackData, lastPlayedAt: Date.now(), addedByUsers, playCount: (existing?.playCount ?? 0) + 1 },
        ...pool.filter(t => !sameTrack(t, trackData))
      ].slice(0, 100)
      await this.room.storage.put("pool", pool)
      this.room.broadcast(json({ type: "pool_update", pool }))
    }

    await this.broadcastQueue(queue)
    await this.fillRobotQueue()
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
    const now = Date.now()
    if (listener.lastMessageAt && now - listener.lastMessageAt < CHAT_RATE_LIMIT_MS) return
    this.connListeners.set(sender.id, { ...listener, lastMessageAt: now })
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

  /** Proactively fill the robot tail to TARGET_ROBOT_DEPTH tracks.
   *  Robot tracks always live at the end of the queue, after any user-queued tracks.
   *  Batches all additions into a single storage write + broadcast.
   *  Runs even with no active listeners so stations stay "always on". */
  private async fillRobotQueue() {
    if (this.robotFilling) return
    this.robotFilling = true
    try {
      const queue = await this.storage<QueueItem[]>("queue", [])
      const pool = (await this.storage<PoolTrack[]>("pool", [])).filter(hasAnyPlatformId)
      if (pool.length === 0) return

      // Count robot tracks already in the tail (positions 1+, not counting now-playing)
      const robotTailCount = queue.slice(1).filter(item => item.addedBy === "robot").length
      const needed = TARGET_ROBOT_DEPTH - robotTailCount
      if (needed <= 0) return

      // Build an exclusion set so we don't immediately repeat a track already in the queue.
      // When the pool is smaller than the queue depth we cycle: clear the set (keeping only
      // the currently-playing track) and allow repeats rather than leaving slots empty.
      const alreadyQueued = new Set<string>(
        queue.flatMap(q => [q.isrc, q.platformIds?.apple].filter((v): v is string => !!v))
      )

      let changed = false
      let poolCycled = false
      let filled = 0
      let attempts = 0
      while (filled < needed && attempts < needed * 4) {
        attempts++
        const candidates = pool.filter(t => {
          if (t.isrc && alreadyQueued.has(t.isrc)) return false
          if (t.platformIds?.apple && alreadyQueued.has(t.platformIds.apple)) return false
          return true
        })
        if (candidates.length === 0) {
          if (poolCycled) break  // still no candidates after cycling — give up
          // Pool fully cycled through the queue — allow repeats (keep pool looping forever)
          poolCycled = true
          alreadyQueued.clear()
          if (queue[0]?.isrc) alreadyQueued.add(queue[0].isrc)
          if (queue[0]?.platformIds?.apple) alreadyQueued.add(queue[0].platformIds.apple)
          continue
        }

        const pick = candidates[Math.floor(Math.random() * candidates.length)]
        if (pick.isrc) alreadyQueued.add(pick.isrc)
        if (pick.platformIds?.apple) alreadyQueued.add(pick.platformIds.apple)

        const { lastPlayedAt: _, addedByUsers: _2, playCount: _3, ...track } = pick
        const last = queue[queue.length - 1]
        // Use max(lastExpiry, now) so robot tracks always have future expiration times
        // even when the existing queue has stale items (e.g. after DO hibernation).
        const startFrom = last ? Math.max(last.expirationTime, Date.now()) : Date.now()
        const expirationTime = startFrom + track.durationMs

        queue.push({
          ...track,
          key: crypto.randomUUID(),
          expirationTime,
          addedByName: undefined,
          addedBy: "robot",
          addedAt: Date.now(),
        })
        filled++
        changed = true
      }

      if (changed) {
        await this.room.storage.put("queue", queue)
        await this.broadcastQueue(queue)
      }
    } finally {
      this.robotFilling = false
    }
  }

  /** Start or restart the alarm chain for a station that has pool tracks but no
   *  active queue/alarm — called when a bootstrap HTTP ping arrives from the index. */
  private async bootstrapIfNeeded() {
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length > 0) {
      // Queue already exists — just re-arm the alarm in case it lapsed after hibernation
      await this.room.storage.setAlarm(queue[0].expirationTime)
      return
    }
    // Empty queue — fill from pool; broadcastQueue inside fillRobotQueue arms the alarm
    await this.fillRobotQueue()
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
      const existing = pool.find(t => sameTrack(t, trackData))
      const prevUsers = existing?.addedByUsers ?? []
      const addedByUsers = addedBy && addedBy !== "robot"
        ? [...new Set([...prevUsers, addedBy])]
        : prevUsers
      pool = [{ ...trackData, lastPlayedAt: now, addedByUsers, playCount: (existing?.playCount ?? 0) + 1 }, ...pool.filter(t => !sameTrack(t, trackData))].slice(0, 100)
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

  // Derive the index room's HTTP URL. Priority:
  //   1. In-memory cache (set from conn.uri on first connect)
  //   2. Storage (persisted in case of DO hibernation between connect and alarm)
  //   3. PARTYKIT_HOST env var (set in partykit.json, only available after deploy)
  //   4. localhost fallback (dev only)
  private async getIndexUrl(): Promise<string> {
    if (this.cachedIndexUrl) return this.cachedIndexUrl
    const stored = await this.room.storage.get<string>("indexUrl")
    if (stored) { this.cachedIndexUrl = stored; return stored }
    const host = (this.room.env as any)?.PARTYKIT_HOST ?? "localhost:1999"
    const protocol = host.startsWith("localhost") ? "http" : "https"
    const url = `${protocol}://${host}/parties/main/index`
    console.warn(`[getIndexUrl] no stored indexUrl for room "${this.cachedRoomId}" — falling back to env/default: ${url}`)
    return url
  }

  private schedulePresenceNotify() {
    if (this.presenceTimer) clearTimeout(this.presenceTimer)
    this.presenceTimer = setTimeout(() => void this.notifyIndexPresence(), 500)
  }

  private async notifyIndexPresence() {
    const listeners: Listener[] = [...this.connListeners.values()].map(({ userId, displayName, isDJ }) => ({ userId, displayName, isDJ }))
    try {
      await this.room.context.parties.main.get("index").fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "station_presence", id: this.getRoomId(), listeners }),
      })
    } catch (e) {
      console.error("[notifyIndexPresence] failed", e)
    }
  }

  // Index room only — merges ephemeral presence into station list before broadcasting.
  // Also strips now-playing metadata from any station whose live window has passed,
  // so clients never see stale track info regardless of what's in storage.
  private withPresence(stations: Station[]): Station[] {
    const now = Date.now()
    return stations.map(s => {
      const isLive = s.liveUntil > now
      return {
        ...s,
        liveUntil: isLive ? s.liveUntil : 0,
        nowPlayingTrackName: isLive ? s.nowPlayingTrackName : undefined,
        nowPlayingArtistName: isLive ? s.nowPlayingArtistName : undefined,
        nowPlayingArtworkUrl: isLive ? s.nowPlayingArtworkUrl : undefined,
        listeners: this.presenceMap.get(s.id) ?? [],
      }
    })
  }

  private async notifyIndex(liveUntil: number, nowPlayingAddedBy?: string, nowPlayingAddedByName?: string, nowPlayingTrackName?: string, nowPlayingArtistName?: string, nowPlayingArtworkUrl?: string) {
    const body = JSON.stringify({ type: "station_status", id: this.getRoomId(), liveUntil, nowPlayingAddedBy, nowPlayingAddedByName, nowPlayingTrackName, nowPlayingArtistName, nowPlayingArtworkUrl })
    const headers = { "Content-Type": "application/json" }

    // Primary: internal service binding — bypasses public-URL auth. Not available in onAlarm context.
    try {
      const res = await this.room.context.parties.main.get("index").fetch("/", { method: "POST", headers, body })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return
    } catch (_e) {
      // context.parties throws a runtime error in onAlarm — fall through to URL approach
    }

    // Fallback: public URL (alarm context where parties binding is unavailable)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(await this.getIndexUrl(), { method: "POST", headers, body })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
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

    // Arm the expiration alarm before notifyIndex — the alarm chain is critical and
    // must not be gated behind the (potentially slow) HTTP call to the index room.
    if (queue.length > 0) {
      await this.room.storage.setAlarm(queue[0].expirationTime)
    }

    // Notify index inline — setTimeout is unreliable here because the DO can be
    // evicted from memory after the event handler returns (especially in no-listener
    // alarm scenarios), cancelling any pending timers before they fire.
    const liveUntil = liveUntilFromQueue(queue)
    const np = queue[0]
    await this.notifyIndex(liveUntil, np?.addedBy, np?.addedByName, np?.name, np?.artistName, np?.artworkUrl)
  }
}

// Use queue[0].expirationTime + a grace buffer as liveUntil.
//
// Why queue[0] (not the last track): using the last robot track's expiration
// (up to 8 × avg_duration ≈ 30 min) keeps a stalled station "live" in the index
// for 30 minutes, showing stale now-playing data. queue[0] gives a much tighter window.
//
// Why the 60-second grace: Cloudflare can fire alarms up to ~30 s after their scheduled
// time. Between queue[0].expirationTime and when the alarm fires + notifyIndex completes,
// `withPresence` would see liveUntil <= now and strip the now-playing data, making the
// station appear "silent" in the list even though it's mid-song. The 60 s buffer covers
// worst-case alarm latency so the station never incorrectly blinks offline.
const LIVE_UNTIL_GRACE_MS = 60_000

function liveUntilFromQueue(queue: QueueItem[]): number {
  if (queue.length === 0) return 0
  // Use max(queue[0].expiry, now) so this never returns a past timestamp when
  // the queue has stale items (e.g. DO just woke from hibernation mid-catch-up).
  return Math.max(queue[0].expirationTime, Date.now()) + LIVE_UNTIL_GRACE_MS
}

/** Match two tracks for pool deduplication.
 *  Never match on empty ISRC — that would collapse all ISRC-less tracks into one. */
function sameTrack(a: Track, b: Track): boolean {
  if (a.isrc && b.isrc) return a.isrc === b.isrc
  if (a.platformIds?.apple && b.platformIds?.apple) return a.platformIds.apple === b.platformIds.apple
  if (a.platformIds?.spotify && b.platformIds?.spotify) return a.platformIds.spotify === b.platformIds.spotify
  return false
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
