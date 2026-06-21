import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Top-level error boundary. Catches any unhandled render-time error
 * so a single broken component doesn't blank-screen the app. Logs to
 * the console for debugging; users see a soft recovery card.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // eslint-disable-next-line no-console
    console.error('App crashed:', error, info.componentStack)
  }

  reset = () => { this.setState({ error: null }) }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-bg text-text">
        <div className="card max-w-sm w-full p-6 text-center">
          <div className="text-4xl mb-3">💥</div>
          <p className="font-bold text-base">Something broke</p>
          <p className="text-xs text-muted mt-1.5 leading-snug">
            We hit an unexpected error. Try again, or reload the page if it persists.
          </p>
          <pre className="mt-4 text-[10px] text-muted/60 font-mono whitespace-pre-wrap break-all text-left bg-surface-2 rounded-lg p-2 max-h-40 overflow-auto">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2 mt-4">
            <button onClick={this.reset} className="btn-ghost flex-1">Try again</button>
            <button onClick={() => location.reload()} className="btn-primary flex-1">Reload</button>
          </div>
        </div>
      </div>
    )
  }
}
