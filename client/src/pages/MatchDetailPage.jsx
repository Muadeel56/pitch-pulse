import { Link, useParams } from 'react-router-dom'
import { useMatch } from '../hooks/useMatches.js'
import { useMatchSocket } from '../hooks/useMatchSocket.js'
import { useFollows, useTeams } from '../hooks/useFollows.js'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { ConnectionStatus } from '../components/ConnectionStatus.jsx'
import { FollowButton } from '../components/FollowButton.jsx'
import { Skeleton } from '../components/Skeleton.jsx'
import styles from './MatchDetailPage.module.css'

export function MatchDetailPage() {
  const { id } = useParams()
  // Initial fetch only — no refetchInterval on this query. Once the socket is
  // connected, every further update arrives over `scoreUpdate` and is written
  // straight into this same cache entry. Open the Network tab: no polling.
  const { data: match, isLoading, isError, error } = useMatch(id)
  const { status } = useMatchSocket(id)

  if (isLoading) {
    return (
      <div className="page">
        <Skeleton lines={4} height={20} />
      </div>
    )
  }

  if (isError) {
    const notFound = error?.code === 'NOT_FOUND'
    return (
      <div className="page">
        <div className="panel">
          <h2>{notFound ? 'Match not found' : 'Couldn’t load this match'}</h2>
          <p className="muted">
            {notFound ? `No match with id "${id}".` : error.message}
          </p>
          <Link className="btn secondary" to="/matches" style={{ marginTop: '1rem' }}>
            ← Back to matches
          </Link>
        </div>
      </div>
    )
  }

  const [teamA, teamB] = match.teams ?? [null, null]
  const score = match.score ?? {}

  return (
    <div className="page">
      <div className={styles.topbar}>
        <Link to="/matches" className="muted">
          ← Matches
        </Link>
        <ConnectionStatus status={status} />
      </div>

      <div className="panel">
        <header className={styles.head}>
          <StatusBadge status={match.status} />
          {match.overs != null && <span className="muted">{match.overs} overs</span>}
        </header>

        <div className={styles.scoreboard}>
          <TeamRow name={teamA} score={score[teamA]} />
          <TeamRow name={teamB} score={score[teamB]} />
        </div>
      </div>

      <FollowTeams teams={match.teams ?? []} />
    </div>
  )
}

function TeamRow({ name, score }) {
  return (
    <div className={styles.row}>
      <span className={styles.team}>{name ?? 'TBD'}</span>
      <span className={styles.big}>{score ?? '—'}</span>
    </div>
  )
}

// A match names teams by string. Only teams that resolve to a seeded Team row
// (India / Australia / England / Pakistan) can be followed — the rest render
// without a control.
function FollowTeams({ teams }) {
  const { data: allTeams } = useTeams()
  const { data: follows } = useFollows()

  if (!allTeams) return null
  const followedIds = new Set((follows?.teams ?? []).map((t) => t.id))
  const resolvable = teams
    .map((name) => allTeams.find((t) => t.name === name))
    .filter(Boolean)

  if (resolvable.length === 0) return null

  return (
    <div className={styles.follows}>
      <h3>Follow a team</h3>
      <div className={styles.followRow}>
        {resolvable.map((team) => (
          <div key={team.id} className={styles.followItem}>
            <span>{team.name}</span>
            <FollowButton kind="team" entity={team} following={followedIds.has(team.id)} />
          </div>
        ))}
      </div>
    </div>
  )
}
