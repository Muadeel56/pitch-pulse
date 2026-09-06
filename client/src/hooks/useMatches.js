import { useQuery } from '@tanstack/react-query'
import { getLiveMatches, getMatch } from '../api/client.js'

// Query keys are exported so the socket hook (Phase D) can write into the same
// cache entries with setQueryData.
export const matchKeys = {
  live: ['matches', 'live'],
  detail: (id) => ['matches', id],
}

export function useLiveMatches() {
  return useQuery({
    queryKey: matchKeys.live,
    queryFn: ({ signal }) => getLiveMatches(signal),
    // Roughly the backend poll cadence (POLL_INTERVAL_MS default 45s), a bit
    // tighter so a change shows without waiting a full backend cycle. The match
    // *detail* page turns its own polling off once the socket is live.
    refetchInterval: 20_000,
  })
}

export function useMatch(id, { enabled = true } = {}) {
  return useQuery({
    queryKey: matchKeys.detail(id),
    queryFn: ({ signal }) => getMatch(id, signal),
    enabled: enabled && !!id,
    // A 404 (NOT_FOUND) is handled by the shared retry policy — it won't retry
    // 4xx, so an unknown id fails fast to the "Match not found" branch.
  })
}
