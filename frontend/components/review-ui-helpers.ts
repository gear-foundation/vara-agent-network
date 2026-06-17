export function shortAddress(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`
}

export function formatTime(value: string) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return 'pending time'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}
