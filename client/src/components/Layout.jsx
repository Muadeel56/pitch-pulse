import { Outlet, useLocation } from 'react-router-dom'
import { NavBar } from './NavBar.jsx'
import { ErrorBoundary } from './ErrorBoundary.jsx'

// Shared shell for the authenticated routes: navbar on top, the matched route
// below wrapped in its own ErrorBoundary (keyed by pathname so navigating away
// from a crashed route clears the error).
export function Layout() {
  const location = useLocation()
  return (
    <>
      <NavBar />
      <ErrorBoundary key={location.pathname}>
        <Outlet />
      </ErrorBoundary>
    </>
  )
}
