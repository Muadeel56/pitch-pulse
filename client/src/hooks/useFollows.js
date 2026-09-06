import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  followPlayer,
  followTeam,
  getFollows,
  getPlayers,
  getTeams,
  unfollowPlayer,
  unfollowTeam,
} from '../api/client.js'

export const followsKey = ['follows']

export function useFollows() {
  return useQuery({ queryKey: followsKey, queryFn: ({ signal }) => getFollows(signal) })
}

export function useTeams() {
  return useQuery({
    queryKey: ['teams'],
    queryFn: ({ signal }) => getTeams(signal),
    staleTime: 5 * 60_000, // seed data barely changes
  })
}

export function usePlayers() {
  return useQuery({
    queryKey: ['players'],
    queryFn: ({ signal }) => getPlayers(signal),
    staleTime: 5 * 60_000,
  })
}

// One mutation for follow + unfollow of a team or player. Optimistically flips
// the `['follows']` cache, rolls back on error, and re-syncs on settle.
export function useToggleFollow() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({ kind, entity, next }) => {
      if (kind === 'team') return next ? followTeam(entity.id) : unfollowTeam(entity.id)
      return next ? followPlayer(entity.id) : unfollowPlayer(entity.id)
    },
    onMutate: async ({ kind, entity, next }) => {
      await qc.cancelQueries({ queryKey: followsKey })
      const previous = qc.getQueryData(followsKey)
      qc.setQueryData(followsKey, (cur) => {
        const base = cur ?? { teams: [], players: [] }
        const listKey = kind === 'team' ? 'teams' : 'players'
        const list = base[listKey] ?? []
        const withoutEntity = list.filter((e) => e.id !== entity.id)
        return {
          ...base,
          [listKey]: next ? [...withoutEntity, entity] : withoutEntity,
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) qc.setQueryData(followsKey, context.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: followsKey }),
  })
}
