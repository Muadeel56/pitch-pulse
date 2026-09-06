import { useFollows, usePlayers, useTeams } from '../hooks/useFollows.js'
import { FollowButton } from '../components/FollowButton.jsx'
import { Skeleton } from '../components/Skeleton.jsx'
import styles from './FollowsPage.module.css'

export function FollowsPage() {
  const follows = useFollows()
  const teams = useTeams()
  const players = usePlayers()

  const loading = follows.isLoading || teams.isLoading || players.isLoading
  const errored = follows.isError || teams.isError || players.isError

  if (loading) {
    return (
      <div className="page">
        <h1>Follows</h1>
        <Skeleton lines={5} height={40} />
      </div>
    )
  }

  if (errored) {
    const msg = (follows.error || teams.error || players.error)?.message
    return (
      <div className="page">
        <h1>Follows</h1>
        <div className="state error">Couldn’t load follows: {msg}</div>
      </div>
    )
  }

  const followedTeamIds = new Set(follows.data.teams.map((t) => t.id))
  const followedPlayerIds = new Set(follows.data.players.map((p) => p.id))
  const nothingFollowed = followedTeamIds.size === 0 && followedPlayerIds.size === 0

  return (
    <div className="page">
      <h1>Follows</h1>
      {nothingFollowed && (
        <p className="muted">You’re not following anyone yet — pick some teams or players below.</p>
      )}

      <Section title="Teams">
        {teams.data.map((team) => (
          <Row
            key={team.id}
            label={`${team.name} (${team.shortName})`}
            control={<FollowButton kind="team" entity={team} following={followedTeamIds.has(team.id)} />}
          />
        ))}
      </Section>

      <Section title="Players">
        {players.data.map((player) => (
          <Row
            key={player.id}
            label={player.name}
            control={
              <FollowButton kind="player" entity={player} following={followedPlayerIds.has(player.id)} />
            }
          />
        ))}
      </Section>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className={styles.section}>
      <h2>{title}</h2>
      <div className={styles.list}>{children}</div>
    </section>
  )
}

function Row({ label, control }) {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      {control}
    </div>
  )
}
