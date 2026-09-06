import { Link } from 'react-router-dom'
import { useUnreadNotifications } from '../hooks/useNotifications.js'
import styles from './NotificationBell.module.css'

export function NotificationBell() {
  const { data } = useUnreadNotifications()
  const unread = (data?.notifications ?? []).filter((n) => !n.read).length

  return (
    <Link to="/notifications" className={styles.bell} aria-label={`Notifications (${unread} unread)`}>
      <span aria-hidden="true">🔔</span>
      {unread > 0 && <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span>}
    </Link>
  )
}
