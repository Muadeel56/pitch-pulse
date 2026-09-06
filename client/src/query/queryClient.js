import { QueryClient } from '@tanstack/react-query'

// One QueryClient for the app. Defaults tuned for a live-scores UI: data goes
// stale quickly (we want fresh scores) but a failed request shouldn't hammer
// the backend. The backend's resilience layer can answer a transient burst with
// a 503 SERVICE_UNAVAILABLE, so retry a few times with backoff before showing
// the error state — but never retry a 4xx (a real NOT_FOUND / VALIDATION_ERROR
// won't fix itself).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        const status = error?.status ?? 0
        if (status >= 400 && status < 500) return false
        return failureCount < 3
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    },
  },
})
