/**
 * Poisson distribution model for soccer match odds.
 * Uses team attack/defense strength vs league averages
 * (derived from home/away standings splits) to compute
 * realistic per-match odds for result, BTTS, and exact score.
 */

export interface TeamStrengths {
  attackHome: number   // goals scored at home / league avg home goals
  defenseHome: number  // goals conceded at home / league avg away goals
  attackAway: number
  defenseAway: number
}

export interface MatchOdds {
  home: number          // decimal odds for home win
  draw: number
  away: number
  bttsYes: number
  bttsNo: number
  homeExpected: number  // expected goals (used for exact score in UI)
  awayExpected: number
}

export interface StandingEntry {
  teamId: number
  playedGames: number
  goalsFor: number
  goalsAgainst: number
}

export interface StandingsData {
  teamStrengths: Map<number, TeamStrengths>
  leagueAvgHome: number
  leagueAvgAway: number
}

// Poisson PMF: P(X = k) for rate lambda
function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let log = -lambda + k * Math.log(lambda)
  for (let i = 1; i <= k; i++) log -= Math.log(i)
  return Math.exp(log)
}

// Convert probability → decimal odds with a small house margin
function toDecimalOdds(p: number, margin = 0.05): number {
  if (p <= 0) return 200
  const raw = (1 / p) * (1 - margin)
  // Round to 2dp, cap at 200
  return Math.min(200, Math.round(raw * 100) / 100)
}

// Net-profit multiplier stored in predictions: decimal_odds - 1
export function decimalToMultiplier(decimalOdds: number): number {
  return Math.max(0.1, Math.round((decimalOdds - 1) * 100) / 100)
}

export function computeMatchOdds(
  home: TeamStrengths,
  away: TeamStrengths,
  leagueAvgHome: number,
  leagueAvgAway: number,
): MatchOdds {
  // Dixon–Coles expected goals
  const homeExp = Math.max(0.3, Math.min(5.0,
    home.attackHome * away.defenseAway * leagueAvgHome
  ))
  const awayExp = Math.max(0.3, Math.min(5.0,
    away.attackAway * home.defenseHome * leagueAvgAway
  ))

  const MAX = 9
  let pHome = 0, pDraw = 0, pAway = 0

  for (let h = 0; h <= MAX; h++) {
    const ph = poissonPmf(homeExp, h)
    for (let a = 0; a <= MAX; a++) {
      const pa = poissonPmf(awayExp, a)
      const joint = ph * pa
      if (h > a) pHome += joint
      else if (h === a) pDraw += joint
      else pAway += joint
    }
  }

  // Normalise (truncation at 9 goals leaves ~0.5% unaccounted)
  const sum = pHome + pDraw + pAway
  pHome /= sum; pDraw /= sum; pAway /= sum

  const pBttsYes = (1 - poissonPmf(homeExp, 0)) * (1 - poissonPmf(awayExp, 0))

  return {
    home:          toDecimalOdds(pHome),
    draw:          toDecimalOdds(pDraw),
    away:          toDecimalOdds(pAway),
    bttsYes:       toDecimalOdds(pBttsYes),
    bttsNo:        toDecimalOdds(1 - pBttsYes),
    homeExpected:  Math.round(homeExp * 100) / 100,
    awayExpected:  Math.round(awayExp * 100) / 100,
  }
}

/** Decimal odds for a specific exact scoreline */
export function exactScoreDecimalOdds(
  homeExpected: number,
  awayExpected: number,
  h: number,
  a: number,
): number {
  const p = poissonPmf(homeExpected, h) * poissonPmf(awayExpected, a)
  return toDecimalOdds(Math.max(p, 0.002)) // floor at ~500x cap
}

/**
 * Estimate the current match minute from kickoff time.
 * The free football-data tier doesn't expose `minute`, so we derive it
 * from elapsed wall-clock time, accounting for the ~15-min half-time break.
 */
export function estimateLiveMinute(kickoffISO: string): number {
  const elapsed = (Date.now() - new Date(kickoffISO).getTime()) / 60000
  if (elapsed <= 0)  return 0
  if (elapsed <= 45) return Math.max(1, Math.floor(elapsed))     // first half
  if (elapsed <= 60) return 45                                    // half-time window
  return Math.min(90, Math.floor(elapsed - 15))                   // second half
}

/**
 * In-play odds. Takes the PRE-MATCH full-90 expected goals, the CURRENT
 * score, and the estimated minute, then models only the goals expected in
 * the remaining time. The locked-in current score is added on top.
 *
 * As the clock runs down, remaining expected goals shrink → the leading
 * side's win odds collapse toward 1.0 and the result hardens.
 */
export function computeLiveOdds(
  homeExpFull: number,
  awayExpFull: number,
  curHome: number,
  curAway: number,
  minute: number,
): MatchOdds {
  const remFrac = Math.max(0, Math.min(1, (90 - minute) / 90))
  const homeRem = homeExpFull * remFrac
  const awayRem = awayExpFull * remFrac

  const MAX = 9
  let pHome = 0, pDraw = 0, pAway = 0

  // Iterate over goals scored by each side in the REMAINING time
  for (let h = 0; h <= MAX; h++) {
    const ph = poissonPmf(homeRem, h)
    for (let a = 0; a <= MAX; a++) {
      const pa = poissonPmf(awayRem, a)
      const joint = ph * pa
      const finalH = curHome + h
      const finalA = curAway + a
      if (finalH > finalA) pHome += joint
      else if (finalH === finalA) pDraw += joint
      else pAway += joint
    }
  }

  const sum = pHome + pDraw + pAway || 1
  pHome /= sum; pDraw /= sum; pAway /= sum

  // BTTS: a team has "scored" if it already has a goal, else needs ≥1 in remaining time
  const pHomeEndsScoring = curHome > 0 ? 1 : (1 - poissonPmf(homeRem, 0))
  const pAwayEndsScoring = curAway > 0 ? 1 : (1 - poissonPmf(awayRem, 0))
  const pBttsYes = pHomeEndsScoring * pAwayEndsScoring

  return {
    home:          toDecimalOdds(pHome),
    draw:          toDecimalOdds(pDraw),
    away:          toDecimalOdds(pAway),
    bttsYes:       toDecimalOdds(pBttsYes),
    bttsNo:        toDecimalOdds(1 - pBttsYes),
    // Expected FINAL goals = current + remaining (used for live exact-score odds)
    homeExpected:  Math.round((curHome + homeRem) * 100) / 100,
    awayExpected:  Math.round((curAway + awayRem) * 100) / 100,
  }
}

/** Risk tier derived from the net-profit multiplier */
export function oddsToRiskTier(multiplier: number): 'low' | 'medium' | 'high' {
  if (multiplier < 1.0) return 'low'      // odds < 2.0  (>50% probability)
  if (multiplier < 3.0) return 'medium'   // odds 2–4    (25–50%)
  return 'high'                            // odds > 4    (<25%)
}

/** Parse HOME + AWAY standings tables from football-data.org into StandingsData */
export function parseStandings(
  homeTable: StandingEntry[],
  awayTable: StandingEntry[],
): StandingsData {
  const totalHomeGoals = homeTable.reduce((s, t) => s + t.goalsFor, 0)
  const totalHomeGames = homeTable.reduce((s, t) => s + t.playedGames, 0)
  const totalAwayGoals = awayTable.reduce((s, t) => s + t.goalsFor, 0)
  const totalAwayGames = awayTable.reduce((s, t) => s + t.playedGames, 0)

  const leagueAvgHome = totalHomeGames > 0 ? totalHomeGoals / totalHomeGames : 1.5
  const leagueAvgAway = totalAwayGames > 0 ? totalAwayGoals / totalAwayGames : 1.2

  const awayMap = new Map(awayTable.map(t => [t.teamId, t]))
  const teamStrengths = new Map<number, TeamStrengths>()

  for (const hEntry of homeTable) {
    const aEntry = awayMap.get(hEntry.teamId)
    if (!aEntry) continue

    const hG = hEntry.playedGames || 1
    const aG = aEntry.playedGames || 1

    teamStrengths.set(hEntry.teamId, {
      attackHome:  Math.max(0.3, (hEntry.goalsFor / hG) / leagueAvgHome),
      defenseHome: Math.max(0.3, (hEntry.goalsAgainst / hG) / leagueAvgAway),
      attackAway:  Math.max(0.3, (aEntry.goalsFor / aG) / leagueAvgAway),
      defenseAway: Math.max(0.3, (aEntry.goalsAgainst / aG) / leagueAvgHome),
    })
  }

  return { teamStrengths, leagueAvgHome, leagueAvgAway }
}

/** Default (neutral) odds when standings are unavailable */
export const DEFAULT_MATCH_ODDS: MatchOdds = {
  home:          2.15,
  draw:          3.40,
  away:          3.60,
  bttsYes:       1.85,
  bttsNo:        2.05,
  homeExpected:  1.45,
  awayExpected:  1.20,
}
