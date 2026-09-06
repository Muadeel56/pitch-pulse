import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError, login as apiLogin, signup as apiSignup } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'

export function SignupPage() {
  const { token, login } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)

  if (token) return <Navigate to="/matches" replace />

  const onSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    setFieldErrors({})
    setSubmitting(true)
    try {
      // The backend returns no token on signup — sign up, then log in.
      await apiSignup(email, password)
      const { token: newToken } = await apiLogin(email, password)
      login(newToken)
      navigate('/matches', { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_ERROR' && err.details?.fieldErrors) {
        const fe = err.details.fieldErrors
        setFieldErrors({
          email: fe.email?.[0],
          password: fe.password?.[0],
        })
        setFormError(err.message)
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page" style={{ maxWidth: 380 }}>
      <h1>Sign up</h1>
      <form className="panel" onSubmit={onSubmit} noValidate>
        {formError && <div className="form-error">{formError}</div>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {fieldErrors.password ? (
            <span className="field-error">{fieldErrors.password}</span>
          ) : (
            <span className="muted" style={{ fontSize: '0.78rem' }}>
              At least 8 characters.
            </span>
          )}
        </div>
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Sign up'}
        </button>
      </form>
      <p className="muted" style={{ marginTop: '1rem' }}>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </div>
  )
}
