import { describe, expect, it } from "vitest"
import {
  buildCategorical,
  composeFingerprint,
  cosine,
  l2normalize,
  selectVibeAware,
  vibeTarget,
  CAT_DIMS,
  FINGERPRINT_DIMS,
  TEXT_DIMS,
  type Candidate,
} from "./fingerprint"

const textOf = (seed: number) => {
  // Deterministic pseudo-embedding so tests don't need a model. Same seed ⇒
  // same direction; different seeds ⇒ roughly orthogonal.
  const v = new Array<number>(TEXT_DIMS).fill(0)
  v[seed % TEXT_DIMS] = 1
  v[(seed * 7 + 3) % TEXT_DIMS] = 0.5
  return v
}

describe("l2normalize / cosine", () => {
  it("normalizes to unit length", () => {
    const n = l2normalize([3, 4])
    expect(Math.hypot(...n)).toBeCloseTo(1)
  })
  it("zero vector stays zero (no NaN)", () => {
    expect(l2normalize([0, 0])).toEqual([0, 0])
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
  it("identical direction ⇒ 1, opposite ⇒ -1", () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1)
  })
})

describe("buildCategorical", () => {
  it("has the declared length and encodes flags", () => {
    const v = buildCategorical({ genreNames: ["Alternative"], year: 2000, hasLyrics: true, explicit: false })
    expect(v).toHaveLength(CAT_DIMS)
    expect(v[CAT_DIMS - 2]).toBe(0) // hasLyrics ⇒ instrumental flag off
    expect(v[CAT_DIMS - 1]).toBe(0) // not explicit
  })
  it("instrumental + explicit flags flip", () => {
    const v = buildCategorical({ hasLyrics: false, explicit: true })
    expect(v[CAT_DIMS - 2]).toBe(1)
    expect(v[CAT_DIMS - 1]).toBe(1)
  })
  it("same genre hashes to the same bucket every time (client/server stable)", () => {
    const a = buildCategorical({ genreNames: ["Electronic"] })
    const b = buildCategorical({ genreNames: ["Electronic"] })
    expect(a).toEqual(b)
  })
})

describe("composeFingerprint", () => {
  it("always has the fixed stored length, text first then categorical", () => {
    const fp = composeFingerprint(textOf(1), { genreNames: ["Rock"], year: 1999 })
    expect(fp).toHaveLength(FINGERPRINT_DIMS)
  })
  it("null/failed text block zeroes the text half (graceful degradation)", () => {
    const fp = composeFingerprint(null, { genreNames: ["Rock"] })
    expect(fp).toHaveLength(FINGERPRINT_DIMS)
    expect(fp.slice(0, TEXT_DIMS).every(x => x === 0)).toBe(true)
    expect(fp.slice(TEXT_DIMS).some(x => x !== 0)).toBe(true) // categorical still present
  })
  it("lower confidence shrinks the text block's contribution", () => {
    const hi = composeFingerprint(textOf(1), { genreNames: ["Rock"] }, 1)
    const lo = composeFingerprint(textOf(1), { genreNames: ["Rock"] }, 0.25)
    const magHi = Math.hypot(...hi.slice(0, TEXT_DIMS))
    const magLo = Math.hypot(...lo.slice(0, TEXT_DIMS))
    expect(magLo).toBeLessThan(magHi)
  })
})

describe("scoring picks the on-vibe track", () => {
  it("a same-mood, same-genre track scores higher than a far-off one", () => {
    const playing = composeFingerprint(textOf(10), { genreNames: ["Ambient"], year: 2018, hasLyrics: false })
    const close = composeFingerprint(textOf(10), { genreNames: ["Ambient"], year: 2019, hasLyrics: false })
    const far = composeFingerprint(textOf(99), { genreNames: ["Death Metal"], year: 1991, explicit: true })
    const target = vibeTarget([playing])
    expect(cosine(close, target)).toBeGreaterThan(cosine(far, target))
  })
})

describe("vibeTarget recency weighting", () => {
  it("most-recent track dominates the centroid", () => {
    const recent = composeFingerprint(textOf(5), { genreNames: ["Jazz"] })
    const old = composeFingerprint(textOf(80), { genreNames: ["Techno"] })
    const target = vibeTarget([recent, old], 0.5)
    expect(cosine(recent, target)).toBeGreaterThan(cosine(old, target))
  })
})

describe("selectVibeAware (MMR)", () => {
  const target = vibeTarget([composeFingerprint(textOf(1), { genreNames: ["Pop"] })])
  const onVibe = (id: string, seed: number, genre: string): Candidate => ({
    id, fingerprint: composeFingerprint(textOf(seed), { genreNames: [genre] }),
  })

  it("returns at most `count`, in pick order, without mutating input", () => {
    const cands = [onVibe("a", 1, "Pop"), onVibe("b", 1, "Pop"), onVibe("c", 50, "Folk")]
    const before = cands.length
    const out = selectVibeAware(target, cands, 2)
    expect(out).toHaveLength(2)
    expect(cands).toHaveLength(before)
  })

  it("low lambda favors variety over a near-duplicate of the first pick", () => {
    // a and b are identical-vibe; c is different. With strong diversity
    // pressure the second pick should be the *different* one, not the twin.
    const cands = [onVibe("a", 1, "Pop"), onVibe("b", 1, "Pop"), onVibe("c", 50, "Folk")]
    const out = selectVibeAware(target, cands, 2, 0.1)
    expect(out[0].id).toBe("a")
    expect(out[1].id).toBe("c")
  })
})
