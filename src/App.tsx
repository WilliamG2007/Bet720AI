import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { LeagueProvider } from './contexts/LeagueContext'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Layout } from './components/Layout'
import AuthPage from './pages/AuthPage'
import FeedPage from './pages/FeedPage'
import PredictPage from './pages/PredictPage'
import LeaguePage from './pages/LeaguePage'
import BetsPage from './pages/BetsPage'
import WorldCupPage from './pages/WorldCupPage'
import MatchDetailPage from './pages/MatchDetailPage'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <LeagueProvider>
          <Routes>
            <Route path="/auth" element={<AuthPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<Layout />}>
                <Route index element={<FeedPage />} />
                <Route path="worldcup" element={<WorldCupPage />} />
                <Route path="predict" element={<PredictPage />} />
                <Route path="league" element={<LeaguePage />} />
                <Route path="bets" element={<BetsPage />} />
                <Route path="match/:matchId" element={<MatchDetailPage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </LeagueProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
