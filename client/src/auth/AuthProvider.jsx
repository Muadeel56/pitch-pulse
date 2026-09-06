import { useCallback, useEffect, useMemo, useState } from 'react'
import { configureApi, TOKEN_STORAGE_KEY } from '../api/client.js'
import { queryClient } from '../query/queryClient.js'
import { AuthContext } from './context.js'

// Decode the `{ id, email }` payload out of a JWT without a library — good
// enough to show who's logged in. Never trusted for authorization (the backend
// verifies the signature); purely cosmetic.
function decodeUser(token) {
  try {
    const [, payload] = token.split('.')
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const { id, email, exp } = JSON.parse(json)
    if (exp && Date.now() >= exp * 1000) return null
    return { id, email }
  } catch {
    return null
  }
}

function readStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => {
    const stored = readStoredToken()
    return stored && decodeUser(stored) ? stored : null
  })
  const user = useMemo(() => (token ? decodeUser(token) : null), [token])

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    setToken(null)
    queryClient.clear()
  }, [])

  const login = useCallback((newToken) => {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, newToken)
    } catch {
      /* ignore */
    }
    setToken(newToken)
  }, [])

  // api/client.js already reads the token straight from localStorage; it just
  // needs to know how to force a logout when the backend rejects a token. (An
  // already-expired token is rejected by the useState initializer above; one
  // that expires mid-session is caught by the 401 handler on the next call.)
  useEffect(() => {
    configureApi({ unauthorizedHandler: logout })
  }, [logout])

  const value = useMemo(() => ({ token, user, login, logout }), [token, user, login, logout])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
