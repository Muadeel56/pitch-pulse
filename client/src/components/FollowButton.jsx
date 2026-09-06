import { useToggleFollow } from '../hooks/useFollows.js'

// `kind` is 'team' | 'player', `entity` is `{ id, name, ... }`, `following` is
// the current state from the ['follows'] cache. The mutation is optimistic, so
// the button flips instantly and rolls back if the request fails.
export function FollowButton({ kind, entity, following }) {
  const toggle = useToggleFollow()
  const pending = toggle.isPending

  return (
    <button
      className={`btn ${following ? 'secondary' : ''}`}
      disabled={pending}
      onClick={() => toggle.mutate({ kind, entity, next: !following })}
    >
      {following ? 'Following ✓' : 'Follow'}
    </button>
  )
}
