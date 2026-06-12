/**
 * Roaming-avatar cache.
 *
 * Avatars are normally derived deterministically from a uid (faceConfigFromUID),
 * so other clients can render any user's face with nothing but their uid. Once a
 * user *customizes* their avatar it's stored on the server profile rail, and this
 * module is how other clients learn about it:
 *
 *   - lazily fetched per uid the first time a face for it is rendered
 *     (deduped), and
 *   - pushed live via the index socket's `profile_update` broadcast.
 *
 * A uid absent from the cache means "no custom face" → callers fall back to the
 * deterministic face. Type-only import of FaceConfig keeps this free of a runtime
 * import cycle with FaceGenerator.
 */
import { useEffect, useSyncExternalStore } from "react"
import type { FaceConfig } from "../components/FaceGenerator"
import { indexSocket } from "./partykit"

const cache = new Map<string, FaceConfig>()
const resolved = new Set<string>()          // uids we've fetched or been told about (incl. "no custom face")
const inflight = new Set<string>()           // uids with a getProfile request in flight
const listeners = new Set<() => void>()

function emit() { for (const l of listeners) l() }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }

function put(uid: string, config: FaceConfig | null) {
  if (config) cache.set(uid, config)
  else cache.delete(uid)
  resolved.add(uid)
  emit()
}

/** Seed/replace a uid's custom face directly (the current user on boot + save). */
export function setCachedFace(uid: string, config: FaceConfig | null) {
  put(uid, config)
}

function ensureFetched(uid: string) {
  if (!uid || resolved.has(uid) || inflight.has(uid)) return
  inflight.add(uid)
  indexSocket.getProfile(uid)
    .then(profile => put(uid, profile?.faceConfig ?? null))
    .catch(() => { /* leave unresolved; a later render retries */ })
    .finally(() => { inflight.delete(uid) })
}

/** Wire live profile_update broadcasts into the cache. Call once at app start. */
export function initProfileCache() {
  indexSocket.onProfileUpdate = (uid, profile) => put(uid, profile.faceConfig ?? null)
}

/** The custom avatar for a uid, or null if none (caller falls back to the
 *  deterministic faceConfigFromUID). Triggers a one-time lazy hydration. */
export function useFaceConfig(uid: string): FaceConfig | null {
  const custom = useSyncExternalStore(subscribe, () => cache.get(uid) ?? null)
  useEffect(() => { ensureFetched(uid) }, [uid])
  return custom
}
