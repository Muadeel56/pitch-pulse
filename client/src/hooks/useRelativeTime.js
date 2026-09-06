import { useEffect, useState } from 'react'

function format(fromMs) {
  const seconds = Math.max(0, Math.round((Date.now() - fromMs) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

// Returns a relative-time string ("updated 4s ago") kept current by a 1s timer.
// The clock is read in the timer callback and stored in state, so render itself
// stays pure. The interval is rebuilt whenever `timestamp` changes.
export function useRelativeTime(timestamp, intervalMs = 1000) {
  const [label, setLabel] = useState(null)

  useEffect(() => {
    if (!timestamp) {
      setLabel(null)
      return undefined
    }
    const update = () => setLabel(format(timestamp))
    update()
    const id = setInterval(update, intervalMs)
    return () => clearInterval(id)
  }, [timestamp, intervalMs])

  return label
}
