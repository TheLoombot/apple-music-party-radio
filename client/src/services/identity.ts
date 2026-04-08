/**
 * Lightweight local user identity using localStorage.
 * Replaces Firebase Anonymous Auth.
 */

export function getUserId(): string {
  let id = localStorage.getItem("ampr_uid")
  if (!id) {
    id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b, i) =>
          ([4,6,8,10].includes(i) ? "-" : "") + b.toString(16).padStart(2, "0")
        ).join("")
    localStorage.setItem("ampr_uid", id)
  }
  return id
}

export function getDisplayName(): string | null {
  return localStorage.getItem("ampr_display_name")
}

export function setDisplayName(name: string) {
  localStorage.setItem("ampr_display_name", name)
}

export function getOwnedStationIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem("ampr_owned_stations") ?? "[]")
  } catch {
    return []
  }
}

export function addOwnedStationId(id: string) {
  const ids = getOwnedStationIds()
  if (!ids.includes(id)) {
    localStorage.setItem("ampr_owned_stations", JSON.stringify([...ids, id]))
  }
}

export function removeOwnedStationId(id: string) {
  const ids = getOwnedStationIds().filter(s => s !== id)
  localStorage.setItem("ampr_owned_stations", JSON.stringify(ids))
}

export function getStationName(id: string): string {
  try {
    const names = JSON.parse(localStorage.getItem("ampr_station_names") ?? "{}")
    return names[id] ?? id
  } catch {
    return id
  }
}

export function setStationName(id: string, name: string) {
  try {
    const names = JSON.parse(localStorage.getItem("ampr_station_names") ?? "{}")
    names[id] = name
    localStorage.setItem("ampr_station_names", JSON.stringify(names))
  } catch {}
}
