import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { NotificationBell } from './NotificationBell.jsx'
import styles from './NavBar.module.css'

// Reads auth from context — no `token` prop drilling.
export function NavBar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        <NavLink to="/matches" className={styles.brand}>
          🏏 PitchPulse
        </NavLink>

        <div className={styles.links}>
          <NavLink to="/matches" className={({ isActive }) => (isActive ? styles.active : undefined)}>
            Matches
          </NavLink>
          <NavLink to="/follows" className={({ isActive }) => (isActive ? styles.active : undefined)}>
            Follows
          </NavLink>
        </div>

        <div className={styles.right}>
          <NotificationBell />
          <span className={styles.email}>{user?.email}</span>
          <button className="btn secondary" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>
    </nav>
  )
}
