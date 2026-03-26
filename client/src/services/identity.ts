/**
 * Lightweight local user identity using localStorage.
 * Replaces Firebase Anonymous Auth.
 */

export function getUserId(): string {
  let id = localStorage.getItem("ampr_uid")
  if (!id) {
    id = crypto.randomUUID()
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
