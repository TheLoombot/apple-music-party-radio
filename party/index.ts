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
  // uid → most-recent-known displayName. Optional so legacy entries without
  // names render the raw uid (per the "no migration" decision); new and
  // updated entries always populate this.
  addedByNames?: Record<string, string>
  playCount: number
}

/** A chat message in the station log. */
interface UserLogEntry {
  kind: "user"
  id: string
  userId: string
  displayName: string
  text: string
  postedAt: number
}

/** Track-change marker in the station log — rendered client-side as a divider,
 *  not a message. Appended whenever the queue head changes (see logTrackChange). */
interface TrackLogEntry {
  kind: "track"
  id: string
  trackKey: string
  title: string
  artist: string
  postedAt: number
}

/** Station chat log entry. Single capped array, oldest first; track dividers
 *  count toward the cap, so old chatter scrolls out by message count. */
type LogEntry = UserLogEntry | TrackLogEntry

/** Persistent record of a user having been in the room. Updated on join and
 *  on disconnect (lastSeenAt = max of those events). Lets the "recent"
 *  section in the comments panel include people who passed through without
 *  saying anything. */
interface Visit {
  userId: string
  displayName: string
  lastSeenAt: number
}

interface Listener {
  userId: string
  displayName: string
  isDJ?: boolean
}

interface ConnectedListener extends Listener {
  isDJ: boolean
  lastMessageAt?: number    // for per-connection chat rate limiting
  lastSuggestionAt?: number // for per-connection suggest rate limiting (3s)
  lastVoteAt?: number       // for per-connection vote rate limiting (500ms)
}

interface SuggestedTrack extends Track {
  key: string
  suggestedBy: string
  suggestedByName?: string
  suggestedAt: number
  votes: number
  votedBy: string[]
}

interface Station {
  id: string
  displayName: string
  storefront: string
  liveUntil: number   // Unix ms; 0 = not live; client computes isLive as liveUntil > Date.now()
  frequency?: number        // FM frequency 66.6–109.9, assigned at creation
  ownerUid?: string         // stored at creation time; undefined for legacy rooms until migrated
  ownerDisplayName?: string // persisted on register so it's known even when owner is offline
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
const MAX_USER_QUEUE_DEPTH = 100

/** Min milliseconds between chat posts per connection (prevents flooding). */
const MESSAGE_RATE_LIMIT_MS = 1000

/** Max characters in a single chat message. */
const MAX_MESSAGE_LENGTH = 256

/** Max chat log entries retained (user messages + track dividers combined).
 *  The log is ephemeral by count — oldest entries fall off the front. */
const MAX_LOG_ENTRIES = 200

/** Max visit records retained. Client filters out present users + takes the
 *  25 most-recent from the union of visits and comments for the recent list. */
const MAX_VISIT_HISTORY = 100

/** Max roaming DJ profiles retained in the index room (uid → display name).
 *  Oldest-updated entries are evicted beyond this. */
const MAX_PROFILES = 5000

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

  // Tombstone flag — set when the station is removed by its owner. Causes
  // onAlarm, handleStation, onConnect, and notifyIndex to bail out so the
  // room can't resurrect itself between deletion and re-creation.
  private cachedDeleted: boolean | null = null

  // Guard against concurrent fillRobotQueue calls (e.g. rapid skips)
  private robotFilling = false

  // Set to true while inside onAlarm — context.parties is unavailable in that
  // context, so notifyIndex skips the binding attempt and goes straight to the URL path.
  private inAlarm = false

  private async isDeleted(): Promise<boolean> {
    if (this.cachedDeleted === null) {
      this.cachedDeleted = (await this.room.storage.get<boolean>("deleted")) === true
    }
    return this.cachedDeleted
  }

  private getRoomId(): string {
    return this.cachedRoomId ?? this.room.id
  }

  /** Send current state to a newly connected client */
  async onConnect(conn: Party.Connection) {
    // room.id can throw "Party.id is not yet initialized" on the very first connect
    // while the DO is still starting up (PartyKit local-dev race / hibernation wakeup).
    // Fall back to the in-memory cache; if neither is available, close with 1013
    // (Try Again Later) so PartySocket retries once the DO is ready.
    let roomId: string
    try {
      roomId = this.room.id
    } catch {
      roomId = this.cachedRoomId ?? ""
    }
    if (!roomId) {
      console.warn("[onConnect] room.id not yet available — closing for retry")
      conn.close(1013, "Room initializing, please retry")
      return
    }
    this.cachedRoomId = roomId

    // Persist roomId on every connect so onAlarm can always recover it after DO hibernation.
    // broadcastQueue also does this, but onConnect covers stations that have never had queue activity.
    if (roomId !== "index") {
      // Refuse connections to deleted stations — clients shouldn't keep
      // chatting with a tombstoned room and re-populating its storage.
      if (await this.isDeleted()) {
        conn.close(1000, "station deleted")
        return
      }
      await this.room.storage.put("roomId", roomId)
    }
    // Derive and persist the index URL from the connection's WebSocket URL so it
    // survives DO hibernation (where room.env is inaccessible in onAlarm).
    // Always re-derive on each connect (no !cachedIndexUrl guard) so a production
    // connection always overwrites any stale URL from a prior dev session.
    // Dev and prod use separate durable storage backends, so localhost URLs in dev
    // storage can never bleed into prod.
    if (roomId !== "index") {
      try {
        const wsUrl = new URL(conn.uri)
        const isSecure = wsUrl.protocol === "wss:" || wsUrl.protocol === "https:"
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
    if (roomId === "index") {
      await this.migrateIndexSchemaIfNeeded()
      const stations = await this.storage<Station[]>("stations", [])
      conn.send(json({ type: "stations_update", stations: this.withPresence(stations) }))
    } else {
      try {
        const { queue, pool } = await this.flushExpired()
        const log = await this.storage<LogEntry[]>("log", [])
        const visits = await this.storage<Visit[]>("visits", [])
        const djs = await this.getDJs()
        const suggestions = await this.storage<SuggestedTrack[]>("suggestions", [])
        const djNotes = await this.storage<Record<string, string>>("dj_notes", {})
        conn.send(json({ type: "state", queue, pool, log, visits, djs, suggestions, djNotes }))
        // Sync live status to index on every connect so stale flags get corrected
        void this.notifyIndex(liveUntilFromQueue(queue), queue[0]?.addedBy, queue[0]?.addedByName, queue[0]?.name, queue[0]?.artistName, queue[0]?.artworkUrl)
        // Re-arm expiration alarm in case the DO restarted and lost it
        if (queue.length > 0) {
          void this.room.storage.setAlarm(queue[0].expirationTime)
        }
        // Proactively top up the robot queue whenever a listener connects
        void this.fillRobotQueue()
      } catch (err) {
        console.error(`[onConnect] error for room ${roomId}:`, err)
        conn.send(json({ type: "state", queue: [], pool: [], log: [], visits: [], djs: [] }))
      }
    }
  }

  async onAlarm() {
    this.inAlarm = true
    try {
      // room.id is inaccessible in onAlarm — restore from storage
      if (!this.cachedRoomId) {
        this.cachedRoomId = await this.room.storage.get<string>("roomId") ?? null
      }
      if (!this.cachedRoomId || this.cachedRoomId === "index") {
        console.warn("[onAlarm] roomId missing from storage — alarm fired but cannot proceed. Stored roomId:", this.cachedRoomId)
        return
      }
      // Station was deleted — bail before any work that would re-arm the alarm
      // or call notifyIndex (which would resurrect the station in the index).
      if (await this.isDeleted()) return
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
            if (refilled.length === 0) {
              // Pool also empty — station genuinely has nothing to play.
              // Only now broadcast the empty queue so clients show "station is quiet".
              this.room.broadcast(json({ type: "queue_update", queue: [] }))
              await this.notifyIndex(0)
            }
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
    } finally {
      this.inAlarm = false
    }
  }

  async onClose(conn: Party.Connection) {
    if (this.getRoomId() === "index") return
    const departed = this.connListeners.get(conn.id)
    this.connListeners.delete(conn.id)
    this.schedulePresenceNotify()
    // Record visit on leave too — captures the moment they last "were here"
    // for ordering in the recent list.
    if (departed) void this.recordVisit(departed.userId, departed.displayName)
    const remaining = [...this.room.getConnections()].filter(c => c.id !== conn.id)
    if (remaining.length > 0) return
    // Last listener left — liveUntil already encodes the correct expiry time,
    // but if the queue is empty there's nothing to expire so clear it now.
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length === 0) {
      await this.notifyIndex(0)
    }
  }

  /** Upsert a visit record with a fresh lastSeenAt + broadcast. Called on
   *  join AND on disconnect so the recent list orders users by their most
   *  recent presence regardless of whether they ever commented. */
  private async recordVisit(userId: string, displayName: string) {
    if (!userId) return
    let visits = await this.storage<Visit[]>("visits", [])
    visits = visits.filter(v => v.userId !== userId)
    visits = [{ userId, displayName, lastSeenAt: Date.now() }, ...visits].slice(0, MAX_VISIT_HISTORY)
    await this.room.storage.put("visits", visits)
    this.room.broadcast(json({ type: "visits_update", visits }))
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
      // GET /parties/main/index/owner?freq=104.5 — look up the recorded owner
      // for a station. Used by station rooms to self-heal when their local
      // ownership record is missing (e.g. /create server-to-server failed silently).
      if (req.method === "GET" && url.pathname.endsWith("/owner")) {
        const freq = url.searchParams.get("freq") ?? ""
        const stations = await this.storage<Station[]>("stations", [])
        const ownerUid = stations.find(s => s.id === freq)?.ownerUid ?? null
        return new Response(JSON.stringify({ ownerUid }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }

      // GET /parties/main/index/profile?uid=<uid> — roaming display name for a
      // uid. Used by clients after recovering their uid from the library
      // identity playlist, so the name follows the profile across devices.
      if (req.method === "GET" && url.pathname.endsWith("/profile")) {
        const uid = url.searchParams.get("uid") ?? ""
        const profiles = await this.storage<Record<string, { displayName: string; updatedAt: number }>>("profiles", {})
        const displayName = profiles[uid]?.displayName ?? null
        return new Response(JSON.stringify({ displayName }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }

      // POST /parties/main/index/create-station — creates a new station and
      // returns its assigned frequency. The frequency string is the station id
      // and PartyKit room name going forward.
      if (req.method === "POST" && url.pathname.endsWith("/create-station")) {
        await this.migrateIndexSchemaIfNeeded()
        const body = await req.json() as { ownerUid: string; displayName: string; storefront: string; preferredFreq?: string }
        if (!body.ownerUid || !body.displayName) {
          return new Response(JSON.stringify({ error: "bad-request" }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }
        const stations = await this.storage<Station[]>("stations", [])
        const takenFreqs = new Set(stations.map(s => s.id).filter(isValidFreqId))
        // The client commits to the freq it previewed; if it's been taken in
        // the meantime, error out so the user can re-open the modal and try
        // again rather than silently landing on a different slot.
        const preferred = body.preferredFreq
        let freqId: string
        if (preferred && isValidFreqId(preferred)) {
          if (takenFreqs.has(preferred)) {
            return new Response(JSON.stringify({ error: "slot-taken", frequency: preferred }), {
              status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
            })
          }
          freqId = preferred
        } else {
          // No preferred freq (or invalid) → fall back to picking any free slot.
          const fallback = pickAvailableFreqId(takenFreqs)
          if (!fallback) {
            return new Response(JSON.stringify({ error: "band-full" }), {
              status: 409, headers: { "Content-Type": "application/json", ...corsHeaders },
            })
          }
          freqId = fallback
        }
        // Reserve the slot atomically in the index before bootstrapping the
        // station room — prevents two concurrent creates from racing.
        const meta: Station = {
          id: freqId,
          displayName: body.displayName,
          storefront: body.storefront,
          liveUntil: 0,
          frequency: parseFloat(freqId),
          ownerUid: body.ownerUid,
        }
        stations.push(meta)
        stations.sort((a, b) => (a.frequency ?? 0) - (b.frequency ?? 0))
        await this.room.storage.put("stations", stations)
        this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))

        // Server-to-server: set ownership on the station room. PartyKit stub
        // .fetch() takes a path starting with "/", not a full URL.
        try {
          const createRes = await this.room.context.parties.main.get(freqId).fetch(
            `/parties/main/${freqId}/create`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ownerUid: body.ownerUid, displayName: body.displayName, storefront: body.storefront }),
            },
          )
          if (!createRes.ok) {
            console.error(`[create-station] /create returned ${createRes.status} for ${freqId}`)
          }
        } catch (e) {
          console.error(`[create-station] failed to set ownership on ${freqId}:`, e)
        }
        return new Response(JSON.stringify({ frequency: freqId }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }

      // POST /parties/main/index — station status/presence pings from station rooms
      if (req.method === "POST") {
        const msg = await req.json() as any
        // Reject pings from station rooms whose id isn't a valid frequency —
        // those are leftover slug-named DOs from the pre-frequency-id model
        // and would otherwise keep auto-reviving themselves into the index
        // after the schema-2 migration drops them.
        if (msg.id && !isValidFreqId(msg.id)) {
          return new Response("ignored: non-frequency id", { status: 200, headers: corsHeaders })
        }
        if (msg.type === "station_status") {
          // Refresh presence from the piggybacked listener list. This is what
          // heals a stale presenceMap after the index DO hibernates — every
          // station_status ping (onConnect, queue change, alarm) re-asserts
          // the station's current listener set. Only update when the field is
          // present so we don't accidentally clear presence from older clients.
          if (Array.isArray(msg.listeners)) {
            this.presenceMap.set(msg.id, msg.listeners)
          }
          const stations = await this.storage<Station[]>("stations", [])
          const idx = stations.findIndex(s => s.id === msg.id)
          if (idx >= 0) {
            const liveUntil = msg.liveUntil ?? 0
            const isLive = liveUntil > 0
            stations[idx] = {
              ...stations[idx],
              liveUntil,
              frequency: stations[idx].frequency ?? randomFrequency(),
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
            // Station is alive but not in the registry — index DO was likely evicted and
            // rebuilt without it. Revive a stub entry so updates aren't dropped, then
            // bootstrap the station so it re-registers with full details on next connect.
            // BUT: only revive if the station claims to be live (liveUntil > 0). An
            // offline ping (liveUntil=0) from an unknown station is almost certainly
            // the disconnect-after-delete race: the user just deleted the station and
            // the station's onClose fired notifyIndex(0) AFTER the registry entry was
            // removed. Reviving here would create a stub with no ownerUid — an
            // un-deletable zombie. Drop the ping instead.
            const liveUntil = msg.liveUntil ?? 0
            const isLive = liveUntil > 0
            if (!isLive) {
              console.log(`[station_status] dropping offline ping from unknown station "${msg.id}" (likely post-delete)`)
              return new Response("ignored: unknown offline station", { status: 200, headers: corsHeaders })
            }
            console.warn(`[station_status] unknown station "${msg.id}" — auto-reviving`)
            const stub: Station = {
              id: msg.id,
              displayName: msg.id,
              storefront: "us",
              liveUntil,
              // Post-big-bang invariant: id === freq string. Don't randomize the
              // numeric `frequency` field, that's how revived zombies used to
              // reappear at "new frequencies".
              frequency: parseFloat(msg.id),
              nowPlayingAddedBy: msg.nowPlayingAddedBy ?? undefined,
              nowPlayingAddedByName: msg.nowPlayingAddedByName ?? undefined,
              nowPlayingTrackName: isLive ? (msg.nowPlayingTrackName ?? undefined) : undefined,
              nowPlayingArtistName: isLive ? (msg.nowPlayingArtistName ?? undefined) : undefined,
              nowPlayingArtworkUrl: isLive ? (msg.nowPlayingArtworkUrl ?? undefined) : undefined,
            }
            stations.push(stub)
            stations.sort((a, b) => (a.frequency ?? 0) - (b.frequency ?? 0))
            await this.room.storage.put("stations", stations)
            this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
            void this.room.context.parties.main.get(msg.id).fetch(
              `/parties/main/${encodeURIComponent(msg.id)}/bootstrap`,
              { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
            ).catch((e: unknown) => console.error(`[bootstrap] failed for revived station "${msg.id}":`, e))
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
        // Re-creating at a previously-deleted freq: clear the tombstone so
        // handlers stop rejecting traffic.
        await this.room.storage.delete("deleted")
        this.cachedDeleted = false
        this.cachedOwnerUid = body.ownerUid
        return new Response("ok", { headers: corsHeaders })
      }

      // POST /parties/main/<freq>/delete — server-to-server from the index room
      // when the user removes the station. Tears the room down so its alarm
      // chain stops broadcasting and pinging the index.
      if (req.method === "POST" && url.pathname.endsWith("/delete")) {
        // Set the tombstone FIRST so any in-flight onAlarm / message handlers
        // see it and bail before they re-arm anything.
        await this.room.storage.put("deleted", true)
        this.cachedDeleted = true
        await this.room.storage.deleteAlarm()
        // Wipe all per-station state — also closes the "re-create at same freq
        // returns 409" gap from CLAUDE.md. Keep `deleted` and `roomId`.
        for (const key of ["ownership", "queue", "pool", "djs", "dj_notes", "comments", "log", "last_logged_track_key", "visits", "suggestions"]) {
          await this.room.storage.delete(key)
        }
        this.cachedOwnerUid = null
        this.cachedDJs = null
        // Close existing WebSocket connections so clients don't keep talking
        // to a dead room (and can't re-populate the storage we just cleared).
        for (const conn of this.room.getConnections()) {
          try { conn.close(1000, "station deleted") } catch { /* ignore */ }
        }
        return new Response("ok", { headers: corsHeaders })
      }

      // POST /parties/main/<slug>/bootstrap — wake a dormant station (sent by index on register)
      if (req.method === "POST" && url.pathname.endsWith("/bootstrap")) {
        // Persist context needed by onAlarm (normally set on first WebSocket connect).
        // Await these writes so the DO has both values in durable storage before returning —
        // if the DO hibernates immediately after this response, onAlarm can still recover them.
        this.cachedRoomId = this.room.id
        await this.room.storage.put("roomId", this.room.id)
        // indexUrl is normally set on first WebSocket connect (from conn.uri) and
        // by getIndexUrl()'s env-var fallback. We no longer derive it here from
        // url.host because stub .fetch() takes a path, so url.host is the internal
        // PartyKit hostname, not the public deployment URL.
        await this.bootstrapIfNeeded()
        return new Response("ok", { headers: corsHeaders })
      }
    }

    return new Response("ok", { headers: corsHeaders })
  }

  // ─── Index room ─────────────────────────────────────────────────────────

  private async handleIndex(msg: any) {
    if (msg.type === "set_profile") {
      const uid = String(msg.uid ?? "").slice(0, 64)
      const displayName = String(msg.displayName ?? "").trim().slice(0, 64)
      if (!uid || !displayName) return
      const profiles = await this.storage<Record<string, { displayName: string; updatedAt: number }>>("profiles", {})
      profiles[uid] = { displayName, updatedAt: Date.now() }
      const entries = Object.entries(profiles)
      if (entries.length > MAX_PROFILES) {
        entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        await this.room.storage.put("profiles", Object.fromEntries(entries.slice(0, MAX_PROFILES)))
      } else {
        await this.room.storage.put("profiles", profiles)
      }
      return
    }
    if (msg.type === "remove_station") {
      let stations = await this.storage<Station[]>("stations", [])
      const target = stations.find(s => s.id === msg.id)
      if (!target) return // already gone
      // Auth: caller must be the recorded owner. Stations with no recorded
      // owner (legacy/zombie stubs) can be removed by anyone — matches the
      // client-side `canRemove = isOwn || !station.ownerUid` gate.
      if (target.ownerUid && target.ownerUid !== msg.ownerUid) {
        console.warn(`[remove_station] unauthorized: uid "${msg.ownerUid}" tried to remove "${msg.id}" (owned by "${target.ownerUid}")`)
        return
      }
      // Tear down the station room FIRST so its alarm chain stops pinging the
      // index. Otherwise the next notifyIndex(liveUntil>0) auto-revives a stub
      // and the station "comes back from the dead" at a random frequency.
      try {
        const res = await this.room.context.parties.main.get(msg.id).fetch(
          `/parties/main/${msg.id}/delete`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        )
        if (!res.ok) console.error(`[remove_station] /delete returned ${res.status} for ${msg.id}`)
      } catch (e) {
        console.error(`[remove_station] failed to /delete station "${msg.id}":`, e)
      }
      stations = stations.filter(s => s.id !== msg.id)
      await this.room.storage.put("stations", stations)
      this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))
      return
    }
    if (msg.type !== "register") return
    // Reject registers for non-frequency ids (legacy slug entries).
    if (!msg.id || !isValidFreqId(msg.id)) return

    const stations = await this.storage<Station[]>("stations", [])
    const idx = stations.findIndex(s => s.id === msg.id)
    const existing = idx >= 0 ? stations[idx] : null
    const meta: Station = {
      ...existing,
      id: msg.id,
      displayName: msg.displayName,
      storefront: msg.storefront,
      liveUntil: existing?.liveUntil ?? 0,
      frequency: msg.frequency != null ? msg.frequency : (existing?.frequency ?? randomFrequency()),
      ownerUid: msg.ownerUid ?? existing?.ownerUid,
      ownerDisplayName: msg.ownerDisplayName ?? existing?.ownerDisplayName,
    }

    if (idx >= 0) stations[idx] = meta
    else stations.push(meta)

    stations.sort((a, b) => (a.frequency ?? 0) - (b.frequency ?? 0))
    await this.room.storage.put("stations", stations)
    this.room.broadcast(json({ type: "stations_update", stations: this.withPresence(stations) }))

    // If the station appears offline, send it a bootstrap ping so it wakes up and
    // starts playing from its pool even with no listeners connected.
    if (!existing || existing.liveUntil <= Date.now()) {
      void this.room.context.parties.main.get(msg.id).fetch(
        `/parties/main/${encodeURIComponent(msg.id)}/bootstrap`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      ).catch((e: unknown) => console.error(`[bootstrap] failed for station "${msg.id}":`, e))
    }
  }

  // ─── Station room ────────────────────────────────────────────────────────

  private async handleStation(msg: any, sender: Party.Connection) {
    // Tombstoned room — drop the message and close the conn. The /delete
    // handler already tried to close all known conns, but in-flight messages
    // or reconnects could still land here.
    if (await this.isDeleted()) {
      try { sender.close(1000, "station deleted") } catch { /* ignore */ }
      return
    }
    switch (msg.type) {
      case "join": {
        const djs = await this.getDJs()
        const isDJ = djs.includes(msg.userId)
        this.connListeners.set(sender.id, { userId: msg.userId, displayName: msg.displayName, isDJ })
        this.schedulePresenceNotify()
        void this.recordVisit(msg.userId, msg.displayName)
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
        // Self-heal: if ownership is still missing (frequency rooms whose /create
        // server-to-server fetch silently failed), look up the recorded owner in
        // the index and adopt it IFF the joining user matches.
        if (!this.cachedOwnerUid && msg.userId) {
          await this.healOwnershipFromIndex(msg.userId)
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
        const added = await this.addTrack(msg.track, msg.addedBy, addedByName)
        if (!added) {
          sender.send(json({ type: "queue_full", limit: MAX_USER_QUEUE_DEPTH }))
          return
        }
        // Remove matching suggestion if one exists (track is now in the queue)
        let suggestions = await this.storage<SuggestedTrack[]>("suggestions", [])
        const matchIdx = suggestions.findIndex(s => sameTrack(s, msg.track))
        if (matchIdx >= 0) {
          suggestions.splice(matchIdx, 1)
          await this.room.storage.put("suggestions", suggestions)
          this.broadcastSuggestions(suggestions)
        }
        // After a user track is added, fill robot tail if it fell short
        await this.fillRobotQueue()
        return
      }
      case "remove_track":     if (!this.isPrivilegedConn(sender)) return; return this.removeTrack(msg.key)
      case "skip_track":                  if (!this.isPrivilegedConn(sender)) return; return this.skipTrack()
      case "skip_and_remove_from_pool":   if (!this.isPrivilegedConn(sender)) return; return this.skipAndRemoveFromPool()
      case "expire_track":     return this.expireTrack(msg.key, msg.addToPool)  // clients self-report their own track advance
      case "remove_from_pool": if (!this.isPrivilegedConn(sender)) return; return this.removeFromPool(msg.isrc)
      case "clear_pool":       if (!this.isPrivilegedConn(sender)) return; return this.clearPool()
      case "robot_dj":         if (!this.isPrivilegedConn(sender)) return; return this.fillRobotQueue()
      case "reorder_queue":    if (!this.isPrivilegedConn(sender)) return; return this.reorderQueue(msg.keys)
      case "suggest_track":    return this.handleSuggestTrack(msg, sender)
      case "vote_suggestion":  return this.handleVoteSuggestion(msg, sender)
      case "enqueue_suggestion": if (!this.isPrivilegedConn(sender)) return; return this.handleEnqueueSuggestion(msg, sender)
      case "remove_suggestion":  if (!this.isPrivilegedConn(sender)) return; return this.handleRemoveSuggestion(msg)
      case "set_dj_note":      if (!this.isPrivilegedConn(sender)) return; return this.handleSetDjNote(msg)
      case "post_comment":     // legacy wire name — old clients with open tabs still send this
      case "post_message":     return this.handlePostMessage(msg, sender)
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

  /** Heal missing ownership by querying the index for the recorded owner of
   *  this station. Only adopts if the joiner's userId matches what the index
   *  records — never let a random user claim by being first to join. */
  private async healOwnershipFromIndex(userId: string): Promise<void> {
    try {
      // PartyKit stub .fetch() takes a path starting with "/", not a full URL.
      const freq = encodeURIComponent(this.cachedRoomId ?? this.room.id)
      const res = await this.room.context.parties.main.get("index").fetch(
        `/parties/main/index/owner?freq=${freq}`,
        { method: "GET" },
      )
      if (!res.ok) return
      const { ownerUid } = await res.json() as { ownerUid: string | null }
      if (ownerUid && ownerUid === userId) {
        const ownership: StationOwnership = { ownerUid, createdAt: Date.now() }
        await this.room.storage.put("ownership", ownership)
        this.cachedOwnerUid = ownerUid
        console.log(`[heal-ownership] adopted ${ownerUid} for room=${this.cachedRoomId}`)
      }
    } catch (e) {
      console.error(`[heal-ownership] failed for room=${this.cachedRoomId}:`, e)
    }
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
    const result = this.isOwnerConn(sender) || this.isDJConn(sender)
    const l = this.connListeners.get(sender.id)
    console.log(`[priv] room=${this.cachedRoomId} listener=${l?.userId} cachedOwner=${this.cachedOwnerUid} djs=${this.cachedDJs?.join(",")} isPriv=${result}`)
    return result
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

  private async addTrack(track: Track, addedBy: string, addedByName?: string): Promise<boolean> {
    const queue = await this.storage<QueueItem[]>("queue", [])

    // Reject if this user already has too many tracks queued (excludes now-playing).
    if (addedBy !== "robot") {
      const userQueued = queue.slice(1).filter(i => i.addedBy === addedBy).length
      if (userQueued >= MAX_USER_QUEUE_DEPTH) return false
    }

    // Promotion: if the track is already in the queue tail as a robot pick,
    // a user "adding" it should move it into the user-tail section (change
    // attribution from "robot" to the requesting user). Avoids creating a
    // duplicate and lets DJs claim a robot-spun track without re-queuing.
    if (addedBy !== "robot") {
      const robotIdx = queue.findIndex((q, i) =>
        i > 0 && q.addedBy === "robot" && sameTrack(q, track)
      )
      if (robotIdx >= 0) {
        const [robotItem] = queue.splice(robotIdx, 1)
        const insertAt = this.getInsertionIndex(queue)
        const predecessor = queue[insertAt - 1] ?? null
        const promoted: QueueItem = {
          ...robotItem,
          addedBy,
          addedByName,
          addedAt: Date.now(),
          expirationTime: predecessor
            ? Math.max(predecessor.expirationTime, Date.now()) + robotItem.durationMs
            : Date.now() + robotItem.durationMs,
        }
        queue.splice(insertAt, 0, promoted)
        // Re-stamp expirations for everything after the new position.
        let cursor = promoted.expirationTime
        for (let i = insertAt + 1; i < queue.length; i++) {
          cursor += queue[i].durationMs
          queue[i] = { ...queue[i], expirationTime: cursor }
        }
        await this.room.storage.put("queue", queue)
        await this.broadcastQueue(queue)
        // Refill the robot tail to compensate for the slot we just took.
        await this.fillRobotQueue()
        return true
      }
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
    return true
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

  private async skipAndRemoveFromPool() {
    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.length === 0) return

    const skipped = queue[0]
    const [, ...rest] = queue
    let cursor = Date.now()
    const newQueue = rest.map(item => {
      cursor += item.durationMs
      return { ...item, expirationTime: cursor }
    })

    await this.room.storage.put("queue", newQueue)
    await this.broadcastQueue(newQueue)

    let pool = await this.storage<PoolTrack[]>("pool", [])
    const newPool = pool.filter(p => !sameTrack(p, skipped))
    if (newPool.length !== pool.length) {
      await this.room.storage.put("pool", newPool)
      this.room.broadcast(json({ type: "pool_update", pool: newPool }))
    }

    await this.fillRobotQueue()
  }

  private async expireTrack(key: string, addToPool: boolean) {
    let queue = await this.storage<QueueItem[]>("queue", [])
    if (!queue[0] || queue[0].key !== key) return  // stale message

    const expired = queue[0]
    queue = queue.slice(1)
    await this.room.storage.put("queue", queue)

    if (addToPool) {
      // Pull addedByName off the queue item so it doesn't leak into trackData
      // as a stale single-name field on PoolTrack; we maintain a per-uid name
      // map instead.
      const { key: _k, expirationTime: _e, addedBy, addedAt: _t, addedByName, ...trackData } = expired
      let pool = await this.storage<PoolTrack[]>("pool", [])
      const existing = pool.find(t => sameTrack(t, trackData))
      const prevUsers = existing?.addedByUsers ?? []
      const addedByUsers = addedBy && addedBy !== "robot"
        ? [...new Set([...prevUsers, addedBy])]
        : prevUsers
      const addedByNames = this.mergePoolNames(existing?.addedByNames, addedBy, addedByName)
      pool = [
        { ...trackData, lastPlayedAt: Date.now(), addedByUsers, addedByNames, playCount: (existing?.playCount ?? 0) + 1 },
        ...pool.filter(t => !sameTrack(t, trackData))
      ].slice(0, 100)
      await this.room.storage.put("pool", pool)
      this.room.broadcast(json({ type: "pool_update", pool }))
    }

    await this.broadcastQueue(queue)
    await this.fillRobotQueue()
  }

  /** Merge a uid→displayName entry into a pool track's names map. Falls back
   *  to the live connListeners (matched by userId) when the queue item didn't
   *  carry an addedByName, so robot-promoted tracks and older queue items
   *  still get a name when possible. Skips "robot" — that addedBy is sentinel. */
  private mergePoolNames(
    prev: Record<string, string> | undefined,
    addedBy: string | undefined,
    addedByName: string | undefined,
  ): Record<string, string> {
    const names = { ...(prev ?? {}) }
    if (!addedBy || addedBy === "robot") return names
    let resolved = addedByName
    if (!resolved) {
      for (const l of this.connListeners.values()) {
        if (l.userId === addedBy) { resolved = l.displayName; break }
      }
    }
    if (resolved) names[addedBy] = resolved
    return names
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

  private async handleSetDjNote(msg: any) {
    const itemId = String(msg.itemId ?? "").trim()
    if (!itemId) return
    const note = String(msg.note ?? "").trim().slice(0, 2500)
    const notes = await this.storage<Record<string, string>>("dj_notes", {})
    if (note) {
      notes[itemId] = note
    } else {
      delete notes[itemId]
    }
    await this.room.storage.put("dj_notes", notes)
    this.room.broadcast(json({ type: "dj_notes_update", djNotes: notes }))
  }

  private async handlePostMessage(msg: any, sender: Party.Connection) {
    const text = (msg.text ?? "").trim().slice(0, MAX_MESSAGE_LENGTH)
    if (!text) return
    let listener = this.connListeners.get(sender.id)
    if (!listener) {
      // DO may have woken from hibernation, losing in-memory connListeners.
      // Fall back to user info embedded in the message and re-register.
      if (!msg.userId) return
      const djs = await this.getDJs()
      listener = { userId: msg.userId, displayName: msg.displayName ?? msg.userId, isDJ: djs.includes(msg.userId) }
      this.connListeners.set(sender.id, listener)
      // Re-registering after hibernation means this user is missing from the
      // index's presenceMap. Push presence now so other listeners see them.
      this.schedulePresenceNotify()
    }
    const now = Date.now()
    if (listener.lastMessageAt && now - listener.lastMessageAt < MESSAGE_RATE_LIMIT_MS) return
    this.connListeners.set(sender.id, { ...listener, lastMessageAt: now })

    await this.appendLogEntry({
      kind: "user",
      id: crypto.randomUUID(),
      userId: listener.userId,
      displayName: listener.displayName,
      text,
      postedAt: now,
    })
  }

  /** Append one entry to the station chat log (capped FIFO) and broadcast. */
  private async appendLogEntry(entry: LogEntry) {
    let log = await this.storage<LogEntry[]>("log", [])
    log = [...log, entry].slice(-MAX_LOG_ENTRIES)
    await this.room.storage.put("log", log)
    this.room.broadcast(json({ type: "log_update", log }))
  }

  /** Log a track-change divider when the queue head differs from the last
   *  logged head. The marker is persisted so the check is idempotent across
   *  hibernation and across the multiple paths that broadcast queue updates. */
  private async logTrackChange(queue: QueueItem[]) {
    const head = queue[0]
    if (!head) return
    const lastKey = await this.room.storage.get<string>("last_logged_track_key")
    if (lastKey === head.key) return
    await this.room.storage.put("last_logged_track_key", head.key)
    await this.appendLogEntry({
      kind: "track",
      id: crypto.randomUUID(),
      trackKey: head.key,
      title: head.name,
      artist: head.artistName,
      postedAt: Date.now(),
    })
  }

  private async handleSuggestTrack(msg: any, sender: Party.Connection) {
    let listener = this.connListeners.get(sender.id)
    if (!listener) {
      if (!msg.userId) return
      const djs = await this.getDJs()
      listener = { userId: msg.userId, displayName: msg.displayName ?? msg.userId, isDJ: djs.includes(msg.userId) }
      this.connListeners.set(sender.id, listener)
      this.schedulePresenceNotify()
    }
    const now = Date.now()
    if (listener.lastSuggestionAt && now - listener.lastSuggestionAt < 3000) return
    this.connListeners.set(sender.id, { ...listener, lastSuggestionAt: now })

    const track: Track = msg.track
    if (!track?.platformIds?.apple) return

    const queue = await this.storage<QueueItem[]>("queue", [])
    if (queue.some(q => sameTrack(q, track))) {
      sender.send(json({ type: "suggestion_already_queued" }))
      return
    }

    let suggestions = await this.storage<SuggestedTrack[]>("suggestions", [])
    const existing = suggestions.find(s => sameTrack(s, track))
    if (existing) {
      if (existing.votedBy.includes(listener.userId)) {
        sender.send(json({ type: "suggestion_already_voted" }))
        return
      }
      existing.votes++
      existing.votedBy.push(listener.userId)
      suggestions = sortSuggestions(suggestions)
      await this.room.storage.put("suggestions", suggestions)
      this.broadcastSuggestions(suggestions)
      return
    }

    if (suggestions.length >= 50) {
      sender.send(json({ type: "suggestions_full", limit: 50 }))
      return
    }

    const newSuggestion: SuggestedTrack = {
      ...track,
      key: crypto.randomUUID(),
      suggestedBy: listener.userId,
      suggestedByName: listener.displayName,
      suggestedAt: now,
      votes: 1,
      votedBy: [listener.userId],
    }
    suggestions = sortSuggestions([...suggestions, newSuggestion])
    await this.room.storage.put("suggestions", suggestions)
    this.broadcastSuggestions(suggestions)
  }

  private async handleVoteSuggestion(msg: any, sender: Party.Connection) {
    let listener = this.connListeners.get(sender.id)
    if (!listener) {
      if (!msg.userId) return
      const djs = await this.getDJs()
      listener = { userId: msg.userId, displayName: msg.displayName ?? msg.userId, isDJ: djs.includes(msg.userId) }
      this.connListeners.set(sender.id, listener)
      this.schedulePresenceNotify()
    }
    const now = Date.now()
    if (listener.lastVoteAt && now - listener.lastVoteAt < 500) return
    this.connListeners.set(sender.id, { ...listener, lastVoteAt: now })

    let suggestions = await this.storage<SuggestedTrack[]>("suggestions", [])
    const suggestion = suggestions.find(s => s.key === msg.key)
    if (!suggestion) return
    if (suggestion.votedBy.includes(listener.userId)) {
      sender.send(json({ type: "suggestion_already_voted" }))
      return
    }
    suggestion.votes++
    suggestion.votedBy.push(listener.userId)
    suggestions = sortSuggestions(suggestions)
    await this.room.storage.put("suggestions", suggestions)
    this.broadcastSuggestions(suggestions)
  }

  private async handleEnqueueSuggestion(msg: any, sender: Party.Connection) {
    let suggestions = await this.storage<SuggestedTrack[]>("suggestions", [])
    const suggestion = suggestions.find(s => s.key === msg.key)
    if (!suggestion) return
    const added = await this.addTrack(suggestion as Track, suggestion.suggestedBy, suggestion.suggestedByName)
    if (!added) {
      sender.send(json({ type: "queue_full", limit: MAX_USER_QUEUE_DEPTH }))
      return
    }
    suggestions = suggestions.filter(s => s.key !== msg.key)
    await this.room.storage.put("suggestions", suggestions)
    this.broadcastSuggestions(suggestions)
  }

  private async handleRemoveSuggestion(msg: any) {
    let suggestions = await this.storage<SuggestedTrack[]>("suggestions", [])
    suggestions = suggestions.filter(s => s.key !== msg.key)
    await this.room.storage.put("suggestions", suggestions)
    this.broadcastSuggestions(suggestions)
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
      const rawPool = await this.storage<PoolTrack[]>("pool", [])
      const pool = rawPool.filter(t => !!t.platformIds?.apple)
      if (pool.length < rawPool.length) {
        const removed = rawPool.filter(t => !t.platformIds?.apple)
        console.warn(`[fillRobotQueue] removing ${removed.length} pool track(s) with no Apple ID:`, removed.map(t => `"${t.name}" (isrc=${t.isrc || "none"})`).join(", "))
        await this.room.storage.put("pool", pool)
        this.room.broadcast(json({ type: "pool_update", pool }))
      }
      if (pool.length === 0) return

      // Count robot tracks already in the tail (positions 1+, not counting now-playing)
      const robotTailCount = queue.slice(1).filter(item => item.addedBy === "robot").length
      const needed = TARGET_ROBOT_DEPTH - robotTailCount
      if (needed <= 0) return

      // Exclusion set so we never push a duplicate Apple ID / ISRC into the
      // queue. If the pool is smaller than TARGET_ROBOT_DEPTH we just leave
      // the queue shorter — duplicate IDs end up confusing MusicKit's native
      // queue (positions drift, syncQueueTail miscomputes prefix/append,
      // tracks get appended twice). Better short and clean than long and
      // duplicated. The next track expiry will trigger another fill which
      // can then reuse the just-expired track without violating uniqueness.
      const alreadyQueued = new Set<string>(
        queue.flatMap(q => [q.isrc, q.platformIds?.apple].filter((v): v is string => !!v))
      )

      let changed = false
      let filled = 0
      let attempts = 0
      while (filled < needed && attempts < needed * 4) {
        attempts++
        const candidates = pool.filter(t => {
          if (t.isrc && alreadyQueued.has(t.isrc)) return false
          if (t.platformIds?.apple && alreadyQueued.has(t.platformIds.apple)) return false
          return true
        })
        if (candidates.length === 0) break  // pool exhausted — leave queue short

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
      // Queue already exists — re-arm the alarm and immediately push liveUntil to the
      // index so the station shows as live without waiting for the next alarm to fire.
      await this.room.storage.setAlarm(queue[0].expirationTime)
      const np = queue[0]
      void this.notifyIndex(liveUntilFromQueue(queue), np.addedBy, np.addedByName, np.name, np.artistName, np.artworkUrl)
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
      const { key: _k, expirationTime: _e, addedBy, addedAt: _t, addedByName, ...trackData } = queue[0]
      queue = queue.slice(1)
      const existing = pool.find(t => sameTrack(t, trackData))
      const prevUsers = existing?.addedByUsers ?? []
      const addedByUsers = addedBy && addedBy !== "robot"
        ? [...new Set([...prevUsers, addedBy])]
        : prevUsers
      const addedByNames = this.mergePoolNames(existing?.addedByNames, addedBy, addedByName)
      pool = [{ ...trackData, lastPlayedAt: now, addedByUsers, addedByNames, playCount: (existing?.playCount ?? 0) + 1 }, ...pool.filter(t => !sameTrack(t, trackData))].slice(0, 100)
      changed = true
    }

    if (changed) {
      await this.room.storage.put("queue", queue)
      await this.room.storage.put("pool", pool)
      // Suppress empty queue broadcast — fillRobotQueue will immediately refill and broadcast.
      // Broadcasting an empty queue here would briefly blank nowPlaying on all clients
      // whenever the DO wakes from hibernation with all tracks expired.
      if (queue.length > 0) {
        this.room.broadcast(json({ type: "queue_update", queue }))
        await this.logTrackChange(queue)
      }
      this.room.broadcast(json({ type: "pool_update", pool }))
    }

    return { queue, pool }
  }

  // Derive the index room's HTTP URL. Priority:
  //   1. In-memory cache (set from conn.uri on first connect — production only)
  //   2. Storage (persisted in case of DO hibernation between connect and alarm — production only)
  //   3. PARTYKIT_HOST env var (set in partykit.json, only available after deploy)
  //   4. localhost fallback (dev only)
  // localhost URLs are skipped at every level — they are only valid for the current
  // in-process dev session and must never be used in alarm context after hibernation.
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
    // No setTimeout debounce — PartyKit DOs hibernate aggressively and in-memory
    // timers don't survive hibernation, so a debounced push can be silently lost.
    // The index broadcast is cheap; just fire it now.
    void this.notifyIndexPresence()
  }

  private async notifyIndexPresence() {
    const listeners: Listener[] = [...this.connListeners.values()].map(({ userId, displayName, isDJ }) => ({ userId, displayName, isDJ }))
    // Hibernation desync check: if connListeners is empty but room.getConnections()
    // has live WebSockets, we're about to broadcast a misleading "nobody listening"
    // state. CLAUDE.md describes this exact scenario — DO hibernation wipes the
    // in-memory map but the conns survive, and the next presence push tells the
    // index room everyone's gone.
    try {
      const liveConns = [...this.room.getConnections()].length
      if (liveConns > 0 && listeners.length === 0) {
        console.warn(`[presence] hibernation desync? room=${this.cachedRoomId} liveConns=${liveConns} tracked=0 — about to push empty listeners`)
      }
    } catch { /* getConnections may throw pre-init; ignore */ }
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
    // Tombstoned rooms must never ping the index — that's the exact path that
    // used to resurrect deleted stations via the auto-revive in handleIndex.
    if (await this.isDeleted()) return
    // Piggyback the current listener list onto every status ping so the index's
    // in-memory presenceMap heals itself after hibernation. station_status fires
    // on every onConnect, queue change, and alarm — much more often than the
    // join/leave events that drive presence pushes — so this guarantees that
    // a stale empty presenceMap entry gets corrected within seconds.
    const listeners: Listener[] = [...this.connListeners.values()].map(({ userId, displayName, isDJ }) => ({ userId, displayName, isDJ }))
    const body = JSON.stringify({ type: "station_status", id: this.getRoomId(), liveUntil, nowPlayingAddedBy, nowPlayingAddedByName, nowPlayingTrackName, nowPlayingArtistName, nowPlayingArtworkUrl, listeners })
    const headers = { "Content-Type": "application/json" }

    // Primary: internal service binding — bypasses public-URL auth. Not available in onAlarm context.
    if (!this.inAlarm) {
      try {
        const res = await this.room.context.parties.main.get("index").fetch("/", { method: "POST", headers, body })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return
      } catch (_e) {
        // Unexpected failure outside alarm context — fall through to URL approach
        console.warn(`[notifyIndex] context.parties path failed for room "${this.cachedRoomId}":`, _e)
      }
    }

    // Fallback: public URL (always used in alarm context; parties binding is unavailable there)
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

  /** Index room only. Bumps the stored schema version and drops any
   *  station entries whose id isn't a valid frequency. Runs once per DO
   *  warmup — safe to call multiple times. */
  private async migrateIndexSchemaIfNeeded() {
    const SCHEMA = 2
    const stored = (await this.room.storage.get<number>("schema_version")) ?? 1
    if (stored >= SCHEMA) return
    const stations = await this.room.storage.get<Station[]>("stations") ?? []
    const filtered = stations.filter(s => isValidFreqId(s.id))
    const dropped = stations.length - filtered.length
    if (dropped > 0) {
      console.warn(`[index] schema v${stored} → v${SCHEMA}: dropped ${dropped} non-frequency station entries`)
    }
    await this.room.storage.put("stations", filtered)
    await this.room.storage.put("schema_version", SCHEMA)
  }

  private async storage<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.room.storage.get<any>(key)
    if (raw == null) return fallback
    if (key === "queue" || key === "pool") {
      return (raw as any[]).filter(Boolean).map(migrateTrack) as unknown as T
    }
    return raw as T
  }

  private broadcastSuggestions(suggestions: SuggestedTrack[]) {
    this.room.broadcast(json({ type: "suggestions_update", suggestions }))
  }

  private async broadcastQueue(queue: QueueItem[]) {
    this.room.broadcast(json({ type: "queue_update", queue }))

    // Arm the expiration alarm before notifyIndex — the alarm chain is critical and
    // must not be gated behind the (potentially slow) HTTP call to the index room.
    if (queue.length > 0) {
      await this.room.storage.setAlarm(queue[0].expirationTime)
    }

    await this.logTrackChange(queue)

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
function sortSuggestions(s: SuggestedTrack[]): SuggestedTrack[] {
  return [...s].sort((a, b) => b.votes - a.votes || a.suggestedAt - b.suggestedAt)
}

function sameTrack(a: Track, b: Track): boolean {
  if (a.isrc && b.isrc) return a.isrc === b.isrc
  if (a.platformIds?.apple && b.platformIds?.apple) return a.platformIds.apple === b.platformIds.apple
  if (a.platformIds?.spotify && b.platformIds?.spotify) return a.platformIds.spotify === b.platformIds.spotify
  return false
}

// ─── Frequency band ────────────────────────────────────────────────────────
// Stations are identified by their FM frequency. Real US FM band: 88.1 to 107.9
// with 0.2 spacing = 100 slots total. The frequency string ("103.7") is the
// canonical station id and PartyKit room name.
const FREQ_MIN_X10 = 881   // 88.1 * 10
const FREQ_MAX_X10 = 1079  // 107.9 * 10
const FREQ_STEP_X10 = 2

function allFreqIds(): string[] {
  const out: string[] = []
  for (let n = FREQ_MIN_X10; n <= FREQ_MAX_X10; n += FREQ_STEP_X10) {
    out.push((n / 10).toFixed(1))
  }
  return out
}

function isValidFreqId(s: string): boolean {
  if (!/^\d{2,3}\.\d$/.test(s)) return false
  const n10 = Math.round(parseFloat(s) * 10)
  if (n10 < FREQ_MIN_X10 || n10 > FREQ_MAX_X10) return false
  return (n10 - FREQ_MIN_X10) % FREQ_STEP_X10 === 0
}

function pickAvailableFreqId(taken: Set<string>): string | null {
  const available = allFreqIds().filter(f => !taken.has(f))
  if (available.length === 0) return null
  return available[Math.floor(Math.random() * available.length)]
}

// Legacy: kept for entries that pre-date the frequency-id migration. New
// stations always use isValidFreqId-formatted ids, so their `frequency` field
// is just `parseFloat(s.id)`.
function randomFrequency(): number {
  const ids = allFreqIds()
  return parseFloat(ids[Math.floor(Math.random() * ids.length)])
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
