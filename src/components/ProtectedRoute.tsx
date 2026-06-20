import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export function ProtectedRoute() {
  const { session, loading } = useAuth()

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

  if (!session) return <Navigate to="/auth" replace />
  return <Outlet />
}
