import { StatusBadge } from './StatusBadge.jsx'
import styles from './MatchCard.module.css'

// Stateless — props only, no hooks, no fetching. Given one normalized match
// object it renders the teams, status, per-team score and overs. The parent
// decides whether to wrap it in a link.
export function MatchCard({ match }) {
  const [teamA, teamB] = match.teams ?? [null, null]
  const score = match.score ?? {}

  return (
    <article className={styles.card}>
      <header className={styles.head}>
        <StatusBadge status={match.status} />
        {match.overs != null && <span className={styles.overs}>{match.overs} ov</span>}
      </header>

      <div className={styles.teams}>
        <TeamLine name={teamA} score={teamA ? score[teamA] : null} />
        <span className={styles.vs}>vs</span>
        <TeamLine name={teamB} score={teamB ? score[teamB] : null} />
      </div>
    </article>
  )
}

function TeamLine({ name, score }) {
  return (
    <div className={styles.team}>
      <span className={styles.name}>{name ?? 'TBD'}</span>
      <span className={styles.score}>{score ?? '—'}</span>
    </div>
  )
}
