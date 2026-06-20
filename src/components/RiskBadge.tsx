import type { RiskTier } from '../types/database'

const labels: Record<RiskTier, string> = { low: 'LOW', medium: 'MED', high: 'HIGH' }

export function RiskBadge({ tier }: { tier: RiskTier }) {
  return <span className={`badge-${tier}`}>{labels[tier]}</span>
}
