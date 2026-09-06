import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { useQueryClient } from '@tanstack/react-query'
import { matchKeys } from './useMatches.js'

// Connects to the Socket.io server, joins room `match:<id>`, and pipes every
// `scoreUpdate` straight into the Query cache — the socket IS the fresh data,
// so there is no refetch. Fully tears down on unmount / when matchId changes.
//
// Returns `{ status }` where status ∈ connecting | live | reconnecting | error.
export function useMatchSocket(matchId) {
  const qc = useQueryClient()
  const socketRef = useRef(null) // a socket is a mutable resource, not render state
  const [status, setStatus] = useState('connecting')

  useEffect(() => {
    if (!matchId) return undefined

    // Same origin — in dev the Vite proxy forwards /socket.io with ws:true.
    const socket = io({ transports: ['websocket', 'polling'] })
    socketRef.current = socket

    const join = () => socket.emit('join-match', matchId)

    socket.on('connect', () => {
      setStatus('live')
      join() // re-join after a reconnect too
    })
    socket.on('disconnect', () => setStatus('reconnecting'))
    socket.io.on('reconnect_attempt', () => setStatus('reconnecting'))
    socket.on('connect_error', () => setStatus('error'))

    // Listener registered exactly once for the life of this socket, so a
    // reconnect (which re-emits join-match) never stacks duplicate handlers.
    const onScoreUpdate = (payload) => {
      if (String(payload?.id) !== String(matchId)) return
      const next = payload.match
      if (!next) return // type: 'removed'

      qc.setQueryData(matchKeys.detail(matchId), next)
      // Keep the list view in sync if it's cached. Functional updater → no
      // stale closure over an old list.
      qc.setQueryData(matchKeys.live, (list) =>
        Array.isArray(list) ? list.map((m) => (String(m.id) === String(matchId) ? next : m)) : list,
      )
    }
    socket.on('scoreUpdate', onScoreUpdate)

    return () => {
      socket.emit('leave-match', matchId)
      socket.off('scoreUpdate', onScoreUpdate)
      socket.io.off('reconnect_attempt')
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
  }, [matchId, qc])

  return { status }
}
