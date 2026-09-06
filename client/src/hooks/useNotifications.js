import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api/client.js'

const PAGE_SIZE = 20

// Unread-only, small page — drives the navbar bell badge. There is no
// notifications WebSocket event, so it stays fresh by polling.
export function useUnreadNotifications() {
  return useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: ({ signal }) => getNotifications({ unread: true, limit: 20 }, signal),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  })
}

// Full list for the notifications page, cursor-paginated via nextCursor ↔ before.
export function useNotificationsFeed() {
  return useInfiniteQuery({
    queryKey: ['notifications', 'feed'],
    queryFn: ({ pageParam, signal }) =>
      getNotifications({ limit: PAGE_SIZE, before: pageParam }, signal),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
}

function invalidateAll(qc) {
  qc.invalidateQueries({ queryKey: ['notifications'] })
}

export function useMarkRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => markNotificationRead(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['notifications'] })
      const snapshots = qc.getQueriesData({ queryKey: ['notifications'] })
      // Flip `read` wherever this id appears (feed pages + unread list).
      qc.setQueriesData({ queryKey: ['notifications'] }, (data) => patchRead(data, (n) => n.id === id))
      return { snapshots }
    },
    onError: (_e, _id, ctx) => {
      ctx?.snapshots?.forEach(([key, data]) => qc.setQueryData(key, data))
    },
    onSettled: () => invalidateAll(qc),
  })
}

export function useMarkAllRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['notifications'] })
      const snapshots = qc.getQueriesData({ queryKey: ['notifications'] })
      qc.setQueriesData({ queryKey: ['notifications'] }, (data) => patchRead(data, () => true))
      return { snapshots }
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshots?.forEach(([key, data]) => qc.setQueryData(key, data))
    },
    onSettled: () => invalidateAll(qc),
  })
}

// Handles both the plain `{ notifications, nextCursor }` shape and the
// useInfiniteQuery `{ pages, pageParams }` shape.
function patchRead(data, match) {
  if (!data) return data
  const mapItems = (items) => items.map((n) => (match(n) ? { ...n, read: true } : n))
  if (Array.isArray(data.pages)) {
    return {
      ...data,
      pages: data.pages.map((page) => ({ ...page, notifications: mapItems(page.notifications) })),
    }
  }
  if (Array.isArray(data.notifications)) {
    return { ...data, notifications: mapItems(data.notifications) }
  }
  return data
}
