import { Navigate, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './components/ProtectedRoute.jsx'
import { Layout } from './components/Layout.jsx'
import { LoginPage } from './pages/LoginPage.jsx'
import { SignupPage } from './pages/SignupPage.jsx'
import { MatchesPage } from './pages/MatchesPage.jsx'
import { MatchDetailPage } from './pages/MatchDetailPage.jsx'
import { FollowsPage } from './pages/FollowsPage.jsx'
import { NotificationsPage } from './pages/NotificationsPage.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />

      {/* Everything below requires a token; ProtectedRoute redirects to /login. */}
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/matches" element={<MatchesPage />} />
          <Route path="/matches/:id" element={<MatchDetailPage />} />
          <Route path="/follows" element={<FollowsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/matches" replace />} />
      <Route path="*" element={<Navigate to="/matches" replace />} />
    </Routes>
  )
}
