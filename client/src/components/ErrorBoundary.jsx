import { Component } from 'react'

// Class component because error boundaries have no hook equivalent. Wrap each
// route (and the whole app) so a thrown render error shows a friendly panel
// instead of a blank white screen.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // In a real app this would go to an error reporter.
    console.error('ErrorBoundary caught:', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="page">
        <div className="panel">
          <h2>Something broke on this page</h2>
          <p className="muted">{error.message || 'An unexpected error occurred.'}</p>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button className="btn" onClick={this.reset}>
              Try again
            </button>
            <button className="btn secondary" onClick={() => window.location.assign('/')}>
              Go home
            </button>
          </div>
        </div>
      </div>
    )
  }
}
