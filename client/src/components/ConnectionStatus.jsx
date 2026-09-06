import styles from './ConnectionStatus.module.css'

const MAP = {
  connecting: { label: 'Connecting…', cls: 'connecting' },
  live: { label: 'Live', cls: 'live' },
  reconnecting: { label: 'Reconnecting…', cls: 'reconnecting' },
  error: { label: 'Offline', cls: 'error' },
}

export function ConnectionStatus({ status }) {
  const s = MAP[status] ?? MAP.connecting
  return (
    <span className={`${styles.wrap} ${styles[s.cls]}`}>
      <span className={styles.dot} />
      {s.label}
    </span>
  )
}
