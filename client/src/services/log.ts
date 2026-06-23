// Categorized logger with per-category level filtering.
//
// Categories map to the diagnostic surfaces we care about:
//   queue    — server queue snapshots and changes
//   sync     — app queue ↔ MusicKit native queue alignment
//   playback — playback lifecycle, stalls, errors
//   net      — WebSocket / HTTP transport
//   auth     — MusicKit / Apple session lifecycle
//   app      — top-level user actions (station select/create/delete, reauth)
//   embed    — local embedding model (transformers.js) requests + responses
//
// Default level is `info`, so routine flow is visible without flipping a switch.
// To dig in:
//   localStorage.log = "debug"                       — debug for everything
//   localStorage.log = "queue:debug,sync:debug"      — per-category overrides
//   localStorage.log = "warn,playback:debug"         — global warn + one category louder
//   localStorage.log = "error"                       — only errors (production-quiet)
//
// Reload the page after changing.

type Level = "debug" | "info" | "warn" | "error"
type Category = "queue" | "sync" | "playback" | "net" | "auth" | "app" | "embed"

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const DEFAULT_LEVEL: Level = "info"
const CATEGORIES: Category[] = ["queue", "sync", "playback", "net", "auth", "app", "embed"]

interface Config {
  global: Level
  per: Partial<Record<Category, Level>>
}

function isLevel(s: string): s is Level {
  return s in LEVELS
}

function isCategory(s: string): s is Category {
  return (CATEGORIES as string[]).includes(s)
}

function parseConfig(): Config {
  let raw = ""
  try { raw = localStorage.getItem("log") ?? "" } catch { /* SSR / sandboxed */ }
  const config: Config = { global: DEFAULT_LEVEL, per: {} }
  const trimmed = raw.trim()
  if (!trimmed) return config
  // Single bare level → applies to all categories.
  if (isLevel(trimmed)) {
    config.global = trimmed
    return config
  }
  for (const part of trimmed.split(",").map(p => p.trim()).filter(Boolean)) {
    if (isLevel(part)) {
      config.global = part
      continue
    }
    const [cat, lvl] = part.split(":").map(s => s.trim())
    if (cat && lvl && isCategory(cat) && isLevel(lvl)) {
      config.per[cat] = lvl
    }
  }
  return config
}

const config = parseConfig()

function emit(cat: Category, lvl: Level, args: unknown[]): void {
  const threshold = config.per[cat] ?? config.global
  if (LEVELS[lvl] < LEVELS[threshold]) return
  const prefix = `[${cat}]`
  const fn = lvl === "debug" ? console.debug
    : lvl === "info" ? console.log
    : lvl === "warn" ? console.warn
    : console.error
  fn(prefix, ...args)
}

function bind(c: Category) {
  return {
    debug: (...args: unknown[]) => emit(c, "debug", args),
    info: (...args: unknown[]) => emit(c, "info", args),
    warn: (...args: unknown[]) => emit(c, "warn", args),
    error: (...args: unknown[]) => emit(c, "error", args),
  }
}

export const log = {
  queue: bind("queue"),
  sync: bind("sync"),
  playback: bind("playback"),
  net: bind("net"),
  auth: bind("auth"),
  app: bind("app"),
  embed: bind("embed"),
}
