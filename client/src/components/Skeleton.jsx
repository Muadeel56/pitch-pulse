import styles from './Skeleton.module.css'

// Shimmer placeholder. `lines` stacks a few bars; `height`/`width` size one.
export function Skeleton({ lines = 1, height = 14, width = '100%' }) {
  return (
    <span className={styles.wrap} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className={styles.bar}
          style={{ height, width: i === lines - 1 && lines > 1 ? '60%' : width }}
        />
      ))}
    </span>
  )
}

export function MatchCardSkeleton() {
  return (
    <div className={styles.card}>
      <Skeleton width="40%" height={12} />
      <Skeleton width="70%" height={20} />
      <Skeleton width="55%" height={14} />
    </div>
  )
}
