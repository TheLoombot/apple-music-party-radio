export function relativeTime(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000)
  if (sec < 60) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`
  const days = Math.floor(hr / 24)
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`
  const years = Math.floor(days / 365)
  return `${years} ${years === 1 ? "year" : "years"} ago`
}

export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "0:00"
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}
