import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export function ProtectedRoute() {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="flex items-baseline gap-1">
          <span className="font-bold text-xl text-text">Bet</span>
          <span className="font-bold text-xl text-accent">720</span>
        </div>
      </div>
    )
  }

  // Preserve the requested URL so AuthPage can send the user back after
  // signing in. Crucial for deep-links like /join/<invite_code>.
  if (!session) {
    return <Navigate to="/auth" replace state={{ from: location.pathname + location.search }} />
  }
  return <Outlet />
}
