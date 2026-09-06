import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveMatches } from '../hooks/useMatches.js'
import { useRelativeTime } from '../hooks/useRelativeTime.js'
import { MatchCard } from '../components/MatchCard.jsx'
import { MatchCardSkeleton } from '../components/Skeleton.jsx'
import styles from './MatchesPage.module.css'

const FILTERS = ['all', 'live', 'upcoming', 'completed']
const PAGE = 6

export function MatchesPage() {
  const { data, isLoading, isError, error, isFetching, dataUpdatedAt } = useLiveMatches()
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(PAGE)
  const updatedAgo = useRelativeTime(dataUpdatedAt)

  return (
    <div className="page">
      <header className={styles.header}>
        <h1>Matches</h1>
        {dataUpdatedAt > 0 && (
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {isFetching ? 'updating…' : `updated ${updatedAgo}`}
          </span>
        )}
      </header>

      <div className={styles.filters}>
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`btn secondary ${filter === f ? styles.activeFilter : ''}`}
            onClick={() => {
              setFilter(f)
              setLimit(PAGE)
            }}
          >
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className={styles.grid}>
          {Array.from({ length: 4 }).map((_, i) => (
            <MatchCardSkeleton key={i} />
          ))}
        </div>
      ) : isError ? (
        <div className="state error">
          <p>Couldn’t load matches: {error.message}</p>
        </div>
      ) : (
        <MatchList matches={data ?? []} filter={filter} limit={limit} onMore={() => setLimit((l) => l + PAGE)} />
      )}
    </div>
  )
}

function MatchList({ matches, filter, limit, onMore }) {
  const filtered = filter === 'all' ? matches : matches.filter((m) => m.status === filter)

  if (matches.length === 0) {
    return <div className="state">No matches right now. Check back soon.</div>
  }
  if (filtered.length === 0) {
    return <div className="state">No {filter} matches right now.</div>
  }

  const visible = filtered.slice(0, limit)

  return (
    <>
      <div className={styles.grid}>
        {visible.map((m) => (
          // Stable backend id as the key — never the array index. With a filter +
          // "show more" the list reorders and grows; an index key would let React
          // reuse the wrong card's DOM (and any local state) for a new match.
          <Link key={m.id} to={`/matches/${m.id}`}>
            <MatchCard match={m} />
          </Link>
        ))}
      </div>
      {visible.length < filtered.length && (
        <div style={{ textAlign: 'center', marginTop: '1.25rem' }}>
          <button className="btn secondary" onClick={onMore}>
            Show more ({filtered.length - visible.length})
          </button>
        </div>
      )}
    </>
  )
}
