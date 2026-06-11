/**
 * Pool export/import CSV format (RFC 4180).
 *
 * The header row is the contract: the importer matches columns by header name,
 * ignores unknown columns, and tolerates missing optional ones. A row needs
 * only `isrc` OR `apple_id` to be importable — everything else is re-resolved
 * from the Apple catalog on import, so the file is hand-editable (a row with
 * just an ISRC imports as a fully-formed track).
 */
import type { PoolTrack } from "../types"

export const POOL_CSV_HEADER = ["name", "artist", "album", "isrc", "apple_id", "duration_ms", "play_count", "last_played", "added_by"] as const

export interface PoolCsvRow {
  name: string
  artist: string
  album: string
  isrc: string
  appleId: string
  durationMs?: number
  playCount?: number
  lastPlayedAt?: number // Unix ms
  addedBy?: string
}

/** Quote a field per RFC 4180 when it contains a comma, quote, or newline. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function isoDate(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return ""
  try { return new Date(ms).toISOString().slice(0, 10) } catch { return "" }
}

export function poolToCsv(pool: PoolTrack[]): string {
  const lines = [POOL_CSV_HEADER.join(",")]
  for (const t of pool) {
    const addedBy = Object.values(t.addedByNames ?? {}).join("; ")
    lines.push([
      csvField(t.name),
      csvField(t.artistName),
      csvField(t.albumName),
      csvField(t.isrc ?? ""),
      csvField(t.platformIds?.apple ?? ""),
      String(t.durationMs || ""),
      String(t.playCount || ""),
      isoDate(t.lastPlayedAt),
      csvField(addedBy),
    ].join(","))
  }
  return lines.join("\r\n") + "\r\n"
}

/** RFC 4180 parser — handles quoted fields containing commas, escaped quotes,
 *  and embedded newlines. Returns rows of raw string cells. */
function parseCsvCells(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let inQuotes = false
  let i = 0
  // Strip a UTF-8 BOM (Excel prepends one)
  if (text.charCodeAt(0) === 0xfeff) i = 1

  const endCell = () => { row.push(cell); cell = "" }
  const endRow = () => { endCell(); rows.push(row); row = [] }

  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      cell += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ",") { endCell(); i++; continue }
    if (c === "\r") { if (text[i + 1] === "\n") i++; endRow(); i++; continue }
    if (c === "\n") { endRow(); i++; continue }
    cell += c; i++
  }
  // Final cell/row when the file doesn't end with a newline
  if (cell.length > 0 || row.length > 0) endRow()
  return rows.filter(r => r.some(c => c.trim() !== ""))
}

function toInt(s: string | undefined): number | undefined {
  if (!s) return undefined
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Parse a pool CSV. Throws if the header row has neither an `isrc` nor an
 *  `apple_id` column. Rows lacking both IDs are still returned — callers
 *  filter and report them as skipped. */
export function parsePoolCsv(text: string): PoolCsvRow[] {
  const rows = parseCsvCells(text)
  if (rows.length === 0) return []

  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  if (col("isrc") < 0 && col("apple_id") < 0) {
    throw new Error("Not a pool CSV — header row needs an `isrc` or `apple_id` column")
  }
  const cell = (r: string[], name: string) => {
    const idx = col(name)
    return idx >= 0 ? (r[idx] ?? "").trim() : ""
  }

  return rows.slice(1).map(r => {
    const lastPlayed = cell(r, "last_played")
    const parsedDate = lastPlayed ? Date.parse(lastPlayed) : NaN
    return {
      name: cell(r, "name"),
      artist: cell(r, "artist"),
      album: cell(r, "album"),
      isrc: cell(r, "isrc"),
      appleId: cell(r, "apple_id"),
      durationMs: toInt(cell(r, "duration_ms")),
      playCount: toInt(cell(r, "play_count")),
      lastPlayedAt: Number.isFinite(parsedDate) ? parsedDate : undefined,
      addedBy: cell(r, "added_by") || undefined,
    }
  })
}
