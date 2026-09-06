import { useNotificationsFeed, useMarkAllRead, useMarkRead } from '../hooks/useNotifications.js'
import { Skeleton } from '../components/Skeleton.jsx'
import styles from './NotificationsPage.module.css'

const TYPE_ICON = {
  wicketFallen: '🏏',
  milestoneReached: '🎯',
  matchStarted: '🚀',
}

export function NotificationsPage() {
  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useNotificationsFeed()
  const markRead = useMarkRead()
  const markAll = useMarkAllRead()

  if (isLoading) {
    return (
      <div className="page">
        <h1>Notifications</h1>
        <Skeleton lines={6} height={44} />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="page">
        <h1>Notifications</h1>
        <div className="state error">Couldn’t load notifications: {error.message}</div>
      </div>
    )
  }

  const items = data.pages.flatMap((p) => p.notifications)
  const hasUnread = items.some((n) => !n.read)

  return (
    <div className="page">
      <header className={styles.header}>
        <h1>Notifications</h1>
        {hasUnread && (
          <button className="btn secondary" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
            Mark all read
          </button>
        )}
      </header>

      {items.length === 0 ? (
        <div className="state">No notifications yet. Follow a team to start getting them.</div>
      ) : (
        <ul className={styles.list}>
          {items.map((n) => (
            <li key={n.id} className={`${styles.item} ${n.read ? styles.read : ''}`}>
              <span className={styles.icon} aria-hidden="true">
                {TYPE_ICON[n.type] ?? '🔔'}
              </span>
              <div className={styles.body}>
                <p className={styles.message}>{n.message}</p>
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  {new Date(n.createdAt).toLocaleString()}
                </span>
              </div>
              {!n.read && (
                <button
                  className="btn secondary"
                  onClick={() => markRead.mutate(n.id)}
                  disabled={markRead.isPending}
                >
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasNextPage && (
        <div style={{ textAlign: 'center', marginTop: '1.25rem' }}>
          <button className="btn secondary" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}
