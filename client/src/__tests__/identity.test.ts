import { describe, it, expect, beforeEach } from "vitest"
import {
  getUserId,
  getDisplayName,
  setDisplayName,
  getOwnedStationIds,
  addOwnedStationId,
  removeOwnedStationId,
  getStationName,
  setStationName,
} from "../services/identity"

beforeEach(() => {
  localStorage.clear()
})

// ─── getUserId ────────────────────────────────────────────────────────────────

describe("getUserId", () => {
  it("generates a non-empty UUID on first call", () => {
    const id = getUserId()
    expect(id).toBeTruthy()
    expect(id.length).toBeGreaterThan(10)
  })

  it("returns the same ID on repeated calls", () => {
    const id1 = getUserId()
    const id2 = getUserId()
    expect(id1).toBe(id2)
  })

  it("persists the ID in localStorage under ampr_uid", () => {
    const id = getUserId()
    expect(localStorage.getItem("ampr_uid")).toBe(id)
  })

  it("returns the ID stored in localStorage if one already exists", () => {
    localStorage.setItem("ampr_uid", "pre-existing-id")
    expect(getUserId()).toBe("pre-existing-id")
  })
})

// ─── getDisplayName / setDisplayName ─────────────────────────────────────────

describe("getDisplayName / setDisplayName", () => {
  it("returns null when no name has been set", () => {
    expect(getDisplayName()).toBeNull()
  })

  it("returns the name after setDisplayName", () => {
    setDisplayName("DJ Flux")
    expect(getDisplayName()).toBe("DJ Flux")
  })

  it("overwrites a previous name", () => {
    setDisplayName("First Name")
    setDisplayName("Second Name")
    expect(getDisplayName()).toBe("Second Name")
  })
})

// ─── getOwnedStationIds / add / remove ───────────────────────────────────────

describe("getOwnedStationIds", () => {
  it("returns an empty array when no stations have been added", () => {
    expect(getOwnedStationIds()).toEqual([])
  })

  it("returns an empty array when localStorage contains malformed JSON", () => {
    localStorage.setItem("ampr_owned_stations", "not-json{{{")
    expect(getOwnedStationIds()).toEqual([])
  })
})

describe("addOwnedStationId", () => {
  it("adds a station ID to the list", () => {
    addOwnedStationId("station-a")
    expect(getOwnedStationIds()).toContain("station-a")
  })

  it("does not add duplicate IDs", () => {
    addOwnedStationId("station-a")
    addOwnedStationId("station-a")
    expect(getOwnedStationIds().filter(s => s === "station-a")).toHaveLength(1)
  })

  it("can hold multiple distinct IDs", () => {
    addOwnedStationId("station-a")
    addOwnedStationId("station-b")
    addOwnedStationId("station-c")
    expect(getOwnedStationIds()).toEqual(["station-a", "station-b", "station-c"])
  })
})

describe("removeOwnedStationId", () => {
  it("removes an existing station ID", () => {
    addOwnedStationId("station-a")
    addOwnedStationId("station-b")
    removeOwnedStationId("station-a")
    expect(getOwnedStationIds()).not.toContain("station-a")
    expect(getOwnedStationIds()).toContain("station-b")
  })

  it("is a no-op when the ID is not in the list", () => {
    addOwnedStationId("station-a")
    removeOwnedStationId("station-z")
    expect(getOwnedStationIds()).toEqual(["station-a"])
  })
})

// ─── getStationName / setStationName ─────────────────────────────────────────

describe("getStationName / setStationName", () => {
  it("returns the station ID as a fallback when no name has been set", () => {
    expect(getStationName("my-station")).toBe("my-station")
  })

  it("returns the stored display name after setStationName", () => {
    setStationName("my-station", "Chill Vibes FM")
    expect(getStationName("my-station")).toBe("Chill Vibes FM")
  })

  it("can store names for multiple stations independently", () => {
    setStationName("station-a", "Name A")
    setStationName("station-b", "Name B")
    expect(getStationName("station-a")).toBe("Name A")
    expect(getStationName("station-b")).toBe("Name B")
  })

  it("overwrites a previous name for the same station", () => {
    setStationName("my-station", "Old Name")
    setStationName("my-station", "New Name")
    expect(getStationName("my-station")).toBe("New Name")
  })

  it("returns the ID when localStorage contains malformed JSON", () => {
    localStorage.setItem("ampr_station_names", "bad{json")
    expect(getStationName("my-station")).toBe("my-station")
  })
})
