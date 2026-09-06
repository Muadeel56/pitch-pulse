import styles from './StatusBadge.module.css'

const LABELS = {
  live: 'LIVE',
  completed: 'Completed',
  upcoming: 'Upcoming',
  unknown: 'Unknown',
}

// Stateless. Renders a coloured pill for a match status.
export function StatusBadge({ status }) {
  const key = LABELS[status] ? status : 'unknown'
  return <span className={`${styles.badge} ${styles[key]}`}>{LABELS[key]}</span>
}
