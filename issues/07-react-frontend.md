# Issue #7: React Frontend — full client in `client/` (Frontend Phases A–E)

**Labels:** `frontend`, `react`, `epic`
**Milestone:** PitchPulse — Definition of Done
**Estimated effort:** 8–12 days (5 sub-phases, each independently shippable)

## Summary

Build the entire PitchPulse React client in `client/`, learning React from first
principles. The frontend is built in **five ordered sub-phases (A–E)**, each of
which consumes what an already-shipped backend phase produced:

| FE phase | Backend it consumes | What the client gains |
|----------|--------------------|-----------------------|
| A — React fundamentals | Phase 1–2 (auth, follows, matches) | Static → live matches list, controlled auth forms, hand-written fetch states |
| B — Routing & auth context | Phase 3 (API client shape) | react-router, `<ProtectedRoute>`, `AuthProvider`/`useAuth()`, single `api/client.js` |
| C — Server state (TanStack Query) | Phase 4–5 (polling + Redis cache) | `useQuery`/`useMutation`, optimistic follows, `refetchInterval` |
| D — Real-time (WebSockets) | Phase 6 (Socket.io) | `useMatchSocket(matchId)` hook, cache writes from `scoreUpdate`, no polling |
| E — Notifications & polish | Phase 7 + 10 (notifications + polish) | Notifications bell, skeletons, error boundaries, pagination |

**The one rule:** feel the pain before you reach for the library. Do not install
react-router, TanStack Query, or socket.io-client until the phase that introduces
it. Adopting them earlier is magic you can't reason about.

**Definition of Done item this closes (#7):** *"A React frontend (in `client/`)
covers the full flow: sign up / log in, browse & follow, and watch a match page
update live over a WebSocket with no polling — every route handles loading,
empty, and error states without a blank screen."*

---

## Background / Context

The backend is complete through Phase 10 (see `pitchpulse-project-docs.md` and
`issues/01`–`06`). Relevant contracts the client must speak to:

**REST endpoints** (all under the backend origin, default `http://localhost:3000`):

| Method & path | Auth | Notes |
|---|---|---|
| `POST /auth/signup` | no | body `{ email, password }`, returns `201` + `{ user, token }` |
| `POST /auth/login` | no | body `{ email, password }`, returns `{ user, token }` |
| `GET /me` | Bearer | returns the current user |
| `GET /matches/live` | Bearer | array of live match objects |
| `GET /matches/:id` | Bearer | one match; `404` → `{ error: { message, code: 'NOT_FOUND' } }` |
| `GET /follows` | Bearer | current user's followed teams & players |
| `POST /follows/team/:teamId` | Bearer | `409` `ALREADY_FOLLOWING` if dup |
| `DELETE /follows/team/:teamId` | Bearer | |
| `POST /follows/player/:playerId` | Bearer | |
| `DELETE /follows/player/:playerId` | Bearer | |
| `GET /notifications` | Bearer | query `?unread&limit&before`; returns `{ items, nextCursor }` (cursor = oldest row's `createdAt` ISO string, `null` when no more) |
| `PATCH /notifications/:id/read` | Bearer | mark one read |
| `POST /notifications/read-all` | Bearer | mark all read |

**Error shape (every non-2xx):** `{ error: { message: string, code: string } }`.
Known codes: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `ALREADY_FOLLOWING`
(409), `DB_UNAVAILABLE`/`SERVICE_UNAVAILABLE` (503), `BAD_GATEWAY` (502),
`INTERNAL_ERROR` (500).

**WebSocket (Socket.io):** server listens on the same origin. CORS origin is
configurable via env on the backend — add the Vite dev origin to it.
- client `emit('join-match', matchId, ack)` → server puts the socket in room
  `match:{id}` and replies `emit('joined', payload)`.
- server `emit('scoreUpdate', { ...changedMatch })` to that room whenever the
  Phase 4 poll job detects a change.
- No REST polling should occur on a match detail page once the socket is connected.

---

## Non-negotiable stack constraints

**Start with — and ONLY with:** Vite + React, **plain JavaScript (no TS)**,
`fetch` (no axios, no data lib), `useState` + `useEffect` (no state manager),
plain CSS or CSS Modules (no Tailwind, no component kit).

**Add later, strictly in this order, only when the pain is real:**
react-router (Phase B) → `@tanstack/react-query` (Phase C) → Context (Phase B for
auth, expanded in C) → `socket.io-client` + a custom hook (Phase D) →
*(optional)* TypeScript (Phase E) → *(optional)* Tailwind (Phase E).

---

## Scope

### Part A — React fundamentals *(pairs with backend Phase 2)*

#### Steps
1. `npm create vite@latest client -- --template react` (JavaScript, **not** TS).
   Delete boilerplate CSS/logo noise.
2. Configure `client/vite.config.js` dev proxy: `/auth`, `/matches`, `/follows`,
   `/notifications`, `/me` → `http://localhost:3000`.
3. Add `@fastify/cors` to the backend (`src/server.js`), allowing the Vite origin
   (`http://localhost:5173`). Also add that origin to the Socket.io CORS config.
4. Build a **static** matches list first: hardcoded array → `.map()` →
   `<MatchCard>` (props only, no state). *Then* make it real with `fetch` in
   `useEffect`.
5. Write the **loading / error / empty / data** branches by hand for
   `MatchesPage`. This boilerplate is exactly what TanStack Query deletes later —
   you need to have written it once.
6. Build `LoginPage` + `SignupPage` as **controlled inputs**. Store the returned
   JWT in `useState`, then persist to `localStorage`. Surface backend
   `{ error: { message, code } }` in the form UI.
7. Add an ignore-flag / `AbortController` in the fetch effect so a fast unmount
   doesn't set state on a dead component. Observe StrictMode's dev double-invoke
   — that's the lesson, not a bug.

#### Todos
- [ ] `client/` scaffolded with Vite; dev proxy working; `@fastify/cors` on the backend
- [ ] `<MatchCard>` — props only, no state
- [ ] `MatchesPage` — `fetch('/matches/live')` in `useEffect`, handles loading/error/empty/data
- [ ] Correct `key` on the mapped list (a stable id, not the array index — know why index-as-key bites)
- [ ] `LoginPage` / `SignupPage` — controlled forms, submit to `POST /auth/login` & `/auth/signup`
- [ ] JWT in state + `localStorage`; conditional rendering differs logged-in vs out
- [ ] Backend errors surfaced in the form UI
- [ ] Effect cleanup / ignore-flag so unmount-during-fetch doesn't set state

**Core concepts:** components, props vs state, JSX, event handlers, `useEffect` +
dep array + cleanup, conditional & list rendering, lifting state up.

**Checkpoint A:** Open the app, see real matches from the backend, sign up, log
in, and the UI changes on auth state. Every fetch state is visibly handled — no
blank screens, no uncaught promise rejections in the console.

---

### Part B — Routing & auth context *(pairs with backend Phase 3)*

Mirror the backend's "never `fetch` from a route" rule: **never call `fetch` from
a component** — wrap all backend calls in one `client/src/api/client.js`.

#### Steps
1. Add **react-router**. Routes: `/login`, `/signup`, `/matches`, `/matches/:id`,
   `/follows`. Nested layout route with a shared `<NavBar>`.
2. Build `<ProtectedRoute>` — redirects to `/login` when there's no token;
   restores the intended URL after login.
3. You've now prop-drilled `token` through several layers and it hurts — **that's
   why** you lift it into `<AuthProvider>` (`useContext`). Expose a `useAuth()`
   custom hook: `{ user, token, login, logout }`.
4. `api/client.js` reads the token, attaches `Authorization: Bearer <token>`,
   centralizes the base URL, parses `{ error: { message, code } }` into typed
   thrown errors mirroring the backend codes, and calls `logout()` on any `401`.

#### Todos
- [ ] react-router installed; nested layout route with shared `<NavBar>`
- [ ] `useParams` drives `MatchDetailPage` (`GET /matches/:id`; `404` → "Match not found" UI)
- [ ] `useNavigate` for post-login redirect
- [ ] `<ProtectedRoute>` wrapping `/matches`, `/matches/:id`, `/follows`
- [ ] `AuthProvider` + `useAuth()`; **no component receives `token` as a prop anymore**
- [ ] `api/client.js` — single module: auth header, base URL, error parsing, 401 → logout
- [ ] Follow / unfollow buttons on team/player views → `POST`/`DELETE /follows/...`
- [ ] `/follows` page listing followed teams & players (`GET /follows`)

**Core concepts:** client-side routing, route params, protected routes, layouts;
`useContext`; custom hooks; why prop drilling is a smell.

**Checkpoint B:** Deep-linking to `/matches/2` works on a page refresh. Hitting a
protected route while logged out bounces to `/login` and back after login. No
component receives `token` as a prop.

---

### Part C — Server state done right (TanStack Query) *(pairs with backend Phases 4–5)*

#### Steps
1. You've hand-written `useEffect` + `useState` fetching 4+ times now. Install
   `@tanstack/react-query`. You'll recognize everything it gives you as
   boilerplate you already wrote.
2. `QueryClientProvider` at the app root. Convert reads to `useQuery` — keys
   `['matches','live']`, `['matches', id]`, `['follows']`,
   `['notifications']`. Delete the manual loading/error state.
3. Convert follow/unfollow to `useMutation` with **optimistic updates**,
   rollback on error, `invalidateQueries` on settle.
4. `refetchInterval` on `['matches','live']` roughly matching the backend poll
   cadence; `refetchOnWindowFocus` where it makes sense.
5. Wire React Query Devtools in dev. Add an "updated Xs ago" indicator driven by
   `dataUpdatedAt`.

#### Todos
- [ ] `QueryClientProvider` at the app root
- [ ] All GETs migrated to `useQuery`; manual loading/error state deleted
- [ ] `useMutation` for follow/unfollow — optimistic update + rollback + invalidate on settle
- [ ] `refetchInterval` on `['matches','live']`
- [ ] React Query Devtools in dev
- [ ] Visible "updated Xs ago" indicator from `dataUpdatedAt`

**Core concepts:** server state vs client (UI) state; query keys & cache
invalidation; mutations; optimistic UI; staleness vs cache time.

**Checkpoint C:** Follow a team — the button flips instantly (optimistic) and
reverts cleanly if the request fails. The live matches list refreshes on its own.
You deleted more code than you added.

---

### Part D — Real-time (WebSockets) *(pairs with backend Phase 6)*

#### Steps
1. `npm i socket.io-client`.
2. Build `useMatchSocket(matchId)`: connect on mount, `emit('join-match', matchId)`,
   subscribe to `scoreUpdate`, and **clean up fully** on unmount / when `matchId`
   changes (leave the room, remove listeners, disconnect if appropriate).
3. On `scoreUpdate`, write straight into the Query cache
   (`queryClient.setQueryData(['matches', id], ...)`) instead of refetching — the
   socket *is* the fresh data.
4. Hold the socket instance in a `useRef` (it's not render state).
5. Connection status indicator: connecting / live / reconnecting. Reconnect must
   not double-subscribe. Watch for **stale closures** in the `scoreUpdate`
   handler — the classic React real-time bug (use the functional updater form or
   a ref).

#### Todos
- [ ] `useMatchSocket(matchId)` — connect / join / listen / cleanup, no dangling listeners
- [ ] Socket instance in `useRef`, not `useState`
- [ ] `scoreUpdate` payload written into the Query cache via `setQueryData`
- [ ] Connection status indicator (connecting / live / reconnecting)
- [ ] Leaves the match room on unmount; reconnect doesn't double-subscribe
- [ ] No stale closures in the socket handler

**Core concepts:** `useRef` for mutable non-render values; effect cleanup for
real; custom hooks encapsulating a side-effecting resource; stale-closure
pitfalls.

**Checkpoint D:** Open two browser tabs on the same match. Trigger a score change
on the backend (or wait for the mock generator). Both tabs update within seconds,
no refresh, and the Network tab shows **no polling** for that match — the update
arrived over the socket.

---

### Part E — Notifications & polish *(pairs with backend Phases 7 + 10)*

#### Steps
1. Notifications bell in the navbar: `GET /notifications` via `useQuery`, unread
   badge count. Notifications page listing items.
2. Mark-as-read `useMutation` (`PATCH /notifications/:id/read`) + a "mark all
   read" action (`POST /notifications/read-all`), both updating the cache.
3. Polish pass: loading **skeletons** (not spinners); an `<ErrorBoundary>` around
   each route + a global fallback; real empty states.
4. Pagination / infinite scroll on `/notifications` (cursor: `nextCursor` ↔
   `before`) and on the matches list.
5. Add `React.memo` / `useMemo` / `useCallback` **only where the React Devtools
   Profiler shows a real wasted render** — learn them, don't cargo-cult them.
6. *(Optional)* convert `client/` to **TypeScript** now the data shapes are
   stable — type the `api/client.js` responses first.
7. *(Optional)* extract a tiny design-token CSS file; Tailwind only if you
   actively want it.

#### Todos
- [ ] Notifications page + navbar bell with unread count
- [ ] Mark-as-read (single + all) mutations with cache update
- [ ] `<ErrorBoundary>` per route + a global fallback UI
- [ ] Loading skeletons for `MatchesPage` and `NotificationsPage`
- [ ] Cursor pagination / infinite scroll on `/notifications`; pagination on the matches list
- [ ] Profiler-verified memoization only where it measurably helps
- [ ] *(Optional)* TypeScript migration starting from `api/client.js`
- [ ] *(Optional)* design-token CSS file

**Core concepts:** error boundaries; perceived-performance patterns; when NOT to
memoize; (optionally) typing an API boundary.

**Checkpoint E:** Follow a team, trigger a match event involving them on the
backend, and a notification appears in the bell without a manual refresh. Every
route survives a thrown error with a friendly fallback instead of a white screen.

---

## Acceptance Criteria

**Setup & Phase A**
- [ ] `client/` is a Vite + React (JS) app; boilerplate removed
- [ ] Dev proxy forwards `/auth`, `/matches`, `/follows`, `/notifications`, `/me` to `:3000`
- [ ] `@fastify/cors` allows the Vite origin; Socket.io CORS allows it too
- [ ] `<MatchCard>` is stateless; `MatchesPage` handles loading/error/empty/data by hand
- [ ] Mapped lists use a stable id key, not the array index
- [ ] Controlled `LoginPage` / `SignupPage`; JWT in state + `localStorage`; UI differs by auth state
- [ ] Backend `{ error: { message, code } }` shown in the form UI
- [ ] Fetch effects cancel/ignore on unmount — no "set state on unmounted component" warnings

**Phase B**
- [ ] react-router routes `/login`, `/signup`, `/matches`, `/matches/:id`, `/follows` with a shared `<NavBar>` layout
- [ ] `/matches/:id` deep-links on refresh; unknown id → "Match not found"
- [ ] `<ProtectedRoute>` bounces logged-out users to `/login` and back after login
- [ ] `AuthProvider` + `useAuth()`; **no component takes `token` as a prop**
- [ ] All network calls go through `client/src/api/client.js` (no `fetch` in components); it attaches the auth header, centralizes the base URL, parses errors, and logs out on 401
- [ ] Follow / unfollow buttons and a `/follows` page work against the backend

**Phase C**
- [ ] `QueryClientProvider` at the root; every GET uses `useQuery`; hand-rolled loading/error state deleted
- [ ] Follow/unfollow is a `useMutation` with optimistic update, rollback on error, invalidate on settle
- [ ] `['matches','live']` has a `refetchInterval`; Devtools wired in dev
- [ ] "Updated Xs ago" indicator from `dataUpdatedAt`

**Phase D**
- [ ] `useMatchSocket(matchId)` connects, joins `match:{id}`, listens for `scoreUpdate`, and fully cleans up on unmount / matchId change
- [ ] Socket held in `useRef`; `scoreUpdate` updates the cache via `setQueryData` (no refetch)
- [ ] Connection status indicator; reconnect doesn't double-subscribe; no stale-closure bug
- [ ] Two tabs on one match both update live; Network tab shows no polling for that match

**Phase E**
- [ ] Navbar bell with unread count; notifications page; mark-as-read (single + all) with cache updates
- [ ] `<ErrorBoundary>` per route + global fallback — a thrown error never yields a white screen
- [ ] Loading skeletons on `MatchesPage` and `NotificationsPage`; real empty states
- [ ] Cursor pagination / infinite scroll on `/notifications`
- [ ] Any memoization added is justified by a Profiler screenshot in the PR

**Definition of Done (#7)**
- [ ] `docker compose up` brings up the full stack including `client/`
- [ ] End-to-end: sign up → log in → browse matches → follow a team → open a match page → see it update live over the socket with no polling → get a notification in the bell — every route handling loading, empty, and error without a blank screen

---

## Suggested PR breakdown

Ship one PR per sub-phase (A→E), each green at its own checkpoint, rather than one
giant PR. Branch names: `feat/frontend-phase-a` … `feat/frontend-phase-e`.

---

## Out of scope

- Any backend feature work — the backend is done; only `@fastify/cors` + the
  Socket.io CORS origin are touched here, plus a `client` service in
  `docker-compose.yml` / a `client/Dockerfile` for the DoD checkpoint.
- Auth hardening beyond storing the JWT (refresh tokens, silent renew).
- SSR / Next.js — this is a Vite SPA on purpose.
- A component library or design system — plain CSS / CSS Modules; Tailwind is
  explicitly optional and last.

## Notes

- **Order is the point.** Each library is introduced at the exact step you've
  already hit the problem it solves by hand. Do not pull `react-router` or
  `@tanstack/react-query` into Phase A "to save time" — that defeats the
  learning objective of this issue.
- Keep `client/` self-contained: its own `package.json`, its own `node_modules`.
  The repo root stays backend-only.
- StrictMode stays **on** in dev — the double-invoke surfaces effect-cleanup bugs
  you want to find now.
