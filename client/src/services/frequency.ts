// FM band 88.1 to 107.9 with 0.2 spacing = 100 slots. The frequency string
// ("103.7") is the canonical station id, PartyKit room name, and URL path.
// Keep in sync with party/index.ts.

const FREQ_MIN_X10 = 881
const FREQ_MAX_X10 = 1079
const FREQ_STEP_X10 = 2

/** True if `s` looks like a valid FM-band frequency id (e.g. "103.7"). */
export function isValidFreqId(s: string): boolean {
  if (!/^\d{2,3}\.\d$/.test(s)) return false
  const n10 = Math.round(parseFloat(s) * 10)
  if (n10 < FREQ_MIN_X10 || n10 > FREQ_MAX_X10) return false
  return (n10 - FREQ_MIN_X10) % FREQ_STEP_X10 === 0
}

/** Every valid frequency id in the FM band. */
export function allFreqIds(): string[] {
  const out: string[] = []
  for (let n = FREQ_MIN_X10; n <= FREQ_MAX_X10; n += FREQ_STEP_X10) {
    out.push((n / 10).toFixed(1))
  }
  return out
}

/** Pick a random freq id that isn't in `taken`, or null if the band is full.
 *  Used for the create-station modal's preview — the server picks again at
 *  creation time, so this is purely informational. */
export function pickAvailableFreqId(taken: Set<string>): string | null {
  const available = allFreqIds().filter(f => !taken.has(f))
  if (available.length === 0) return null
  return available[Math.floor(Math.random() * available.length)]
}
