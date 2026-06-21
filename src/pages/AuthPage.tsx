import { useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function AuthPage() {
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  // After a successful sign-in, jump back to the URL the user originally
  // requested (set by ProtectedRoute), or fall back to home. This is what
  // makes shareable /join/<code> links actually round-trip.
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/'
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(''); setSuccess(''); setLoading(true)

    if (mode === 'login') {
      const { error } = await signIn(email, password)
      if (error) setError(error.message)
      else navigate(returnTo, { replace: true })
    } else {
      if (username.length < 3) { setError('Username must be at least 3 characters'); setLoading(false); return }
      const { error } = await signUp(email, password, username)
      if (error) setError(error.message)
      else { setSuccess('Check your email to confirm your account.'); setMode('login') }
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-4">
      {/* Background glow */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-accent/5 rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-[360px] relative">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-flex items-baseline gap-0.5 mb-2">
            <span className="text-4xl font-extrabold tracking-tight text-text">bet</span>
            <span className="text-4xl font-extrabold tracking-tight text-accent">720</span>
          </div>
          <p className="text-muted text-sm">Soccer prediction leagues</p>
        </div>

        {/* Card */}
        <div className="card p-6">
          {/* Tabs */}
          <div className="flex bg-surface-2 rounded-xl p-1 mb-6 gap-1">
            {(['login', 'signup'] as const).map(m => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(''); setSuccess('') }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all duration-150 ${
                  mode === m ? 'bg-surface-3 text-text shadow-sm' : 'text-muted hover:text-text'
                }`}
              >
                {m === 'login' ? 'Log in' : 'Sign up'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div>
                <label className="label">Username</label>
                <input className="input" type="text" placeholder="yourhandle"
                  value={username} onChange={e => setUsername(e.target.value)}
                  required minLength={3} maxLength={30} autoComplete="username" />
              </div>
            )}
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" placeholder="you@example.com"
                value={email} onChange={e => setEmail(e.target.value)}
                required autoComplete="email" />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" type="password"
                placeholder={mode === 'signup' ? 'Min. 6 characters' : '••••••••'}
                value={password} onChange={e => setPassword(e.target.value)}
                required minLength={6}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </div>

            {error && (
              <div className="flex items-start gap-2 text-danger text-xs bg-danger/8 border border-danger/20 rounded-xl px-3 py-2.5">
                <span className="mt-0.5">⚠</span> {error}
              </div>
            )}
            {success && (
              <div className="flex items-start gap-2 text-accent text-xs bg-accent/8 border border-accent/20 rounded-xl px-3 py-2.5">
                <span className="mt-0.5">✓</span> {success}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full justify-center text-center mt-2">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-bg/40 border-t-bg rounded-full animate-spin" />
                  {mode === 'login' ? 'Logging in…' : 'Creating account…'}
                </span>
              ) : mode === 'login' ? 'Log in' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="text-center text-muted text-xs mt-5">
          {mode === 'login' ? "No account? " : 'Have an account? '}
          <button onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setSuccess('') }}
            className="text-accent hover:text-accent-dim transition-colors">
            {mode === 'login' ? 'Sign up' : 'Log in'}
          </button>
        </p>
      </div>
    </div>
  )
}
