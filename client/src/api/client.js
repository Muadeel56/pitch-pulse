// The ONE place the client talks to the backend. No component calls fetch
// directly — mirrors the backend's "never fetch from a route handler" rule.
//
// Responsibilities:
//  - centralize the base URL (empty in dev → the Vite proxy handles it)
//  - attach `Authorization: Bearer <token>` from the current session
//  - parse the backend's `{ error: { message, code } }` envelope into a typed
//    thrown ApiError
//  - on any 401, trigger a logout so a dead token can't linger

// REST calls go under a dedicated `/api` prefix so they never collide with the
// client-side routes of the same name (/matches, /follows, /notifications). The
// Vite dev proxy and the production nginx config both strip `/api` before
// forwarding to Fastify.
const BASE_URL = import.meta.env.VITE_API_URL ?? '/api'

export class ApiError extends Error {
  constructor(message, { code, status, details } = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

// localStorage is the source of truth for the token, so the default getter is
// always correct even before the AuthProvider mounts and registers anything.
export const TOKEN_STORAGE_KEY = 'pp_token'
let getToken = () => {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}
let onUnauthorized = () => {}

export function configureApi({ tokenGetter, unauthorizedHandler }) {
  if (tokenGetter) getToken = tokenGetter
  if (unauthorizedHandler) onUnauthorized = unauthorizedHandler
}

async function request(path, { method = 'GET', body, auth = true, signal } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) {
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  let res
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Network error — is the backend running?', { code: 'NETWORK_ERROR' })
  }

  if (res.status === 401 && auth) {
    // Let the caller still see the error, but kick off the logout.
    onUnauthorized()
  }

  if (res.status === 204) return null

  let payload = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!res.ok) {
    const envelope = payload?.error ?? {}
    throw new ApiError(envelope.message || `Request failed (${res.status})`, {
      code: envelope.code || 'UNKNOWN',
      status: res.status,
      details: envelope.details,
    })
  }

  return payload
}

// --- Auth ---
export const signup = (email, password) =>
  request('/auth/signup', { method: 'POST', body: { email, password }, auth: false })

export const login = (email, password) =>
  request('/auth/login', { method: 'POST', body: { email, password }, auth: false })

export const me = (signal) => request('/me', { signal })

// --- Matches ---
export const getLiveMatches = (signal) => request('/matches/live', { signal })
export const getMatch = (id, signal) => request(`/matches/${encodeURIComponent(id)}`, { signal })

// --- Reference data (seeded teams / players) ---
export const getTeams = (signal) => request('/teams', { signal })
export const getPlayers = (signal) => request('/players', { signal })

// --- Follows ---
export const getFollows = (signal) => request('/follows', { signal })
export const followTeam = (teamId) => request(`/follows/team/${teamId}`, { method: 'POST' })
export const unfollowTeam = (teamId) => request(`/follows/team/${teamId}`, { method: 'DELETE' })
export const followPlayer = (playerId) => request(`/follows/player/${playerId}`, { method: 'POST' })
export const unfollowPlayer = (playerId) => request(`/follows/player/${playerId}`, { method: 'DELETE' })

// --- Notifications ---
export function getNotifications({ unread, limit, before } = {}, signal) {
  const params = new URLSearchParams()
  if (unread) params.set('unread', 'true')
  if (limit) params.set('limit', String(limit))
  if (before) params.set('before', before)
  const qs = params.toString()
  return request(`/notifications${qs ? `?${qs}` : ''}`, { signal })
}
export const markNotificationRead = (id) => request(`/notifications/${id}/read`, { method: 'PATCH' })
export const markAllNotificationsRead = () => request('/notifications/read-all', { method: 'POST' })
