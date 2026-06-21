export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string
          username: string
          avatar_url: string | null
          created_at: string
        }
        Insert: {
          id: string
          username: string
          avatar_url?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          username?: string
          avatar_url?: string | null
          created_at?: string
        }
      }
      leagues: {
        Row: {
          id: string
          name: string
          created_by: string
          sport: string
          season: string
          invite_code: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          created_by: string
          sport?: string
          season: string
          invite_code?: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          created_by?: string
          sport?: string
          season?: string
          invite_code?: string
          created_at?: string
        }
      }
      league_members: {
        Row: {
          id: string
          league_id: string
          user_id: string
          total_points: number
          joined_at: string
        }
        Insert: {
          id?: string
          league_id: string
          user_id: string
          total_points?: number
          joined_at?: string
        }
        Update: {
          id?: string
          league_id?: string
          user_id?: string
          total_points?: number
          joined_at?: string
        }
      }
      matches: {
        Row: {
          id: string
          external_id: number
          home_team: string
          away_team: string
          home_crest: string | null
          away_crest: string | null
          competition: string
          kickoff_at: string
          status: 'scheduled' | 'live' | 'finished' | 'postponed'
          home_score: number | null
          away_score: number | null
          matchday: number | null
          season: string | null
          updated_at: string
          home_odds: number | null
          draw_odds: number | null
          away_odds: number | null
          btts_yes_odds: number | null
          btts_no_odds: number | null
          expected_home_goals: number | null
          expected_away_goals: number | null
          stage: string | null
          group: string | null
        }
        Insert: {
          id?: string
          external_id: number
          home_team: string
          away_team: string
          home_crest?: string | null
          away_crest?: string | null
          competition: string
          kickoff_at: string
          status?: 'scheduled' | 'live' | 'finished' | 'postponed'
          home_score?: number | null
          away_score?: number | null
          matchday?: number | null
          season?: string | null
          updated_at?: string
          home_odds?: number | null
          draw_odds?: number | null
          away_odds?: number | null
          btts_yes_odds?: number | null
          btts_no_odds?: number | null
          expected_home_goals?: number | null
          expected_away_goals?: number | null
          stage?: string | null
          group?: string | null
        }
        Update: {
          id?: string
          external_id?: number
          home_team?: string
          away_team?: string
          home_crest?: string | null
          away_crest?: string | null
          competition?: string
          kickoff_at?: string
          status?: 'scheduled' | 'live' | 'finished' | 'postponed'
          home_score?: number | null
          away_score?: number | null
          matchday?: number | null
          season?: string | null
          updated_at?: string
          home_odds?: number | null
          draw_odds?: number | null
          away_odds?: number | null
          btts_yes_odds?: number | null
          btts_no_odds?: number | null
          expected_home_goals?: number | null
          expected_away_goals?: number | null
          stage?: string | null
          group?: string | null
        }
      }
      predictions: {
        Row: {
          id: string
          user_id: string
          match_id: string
          league_id: string
          prediction_type: 'result' | 'exact_score' | 'btts'
          predicted_value: string
          risk_tier: 'low' | 'medium' | 'high'
          points_wagered: number
          points_won: number | null
          double_or_nothing: boolean
          resolved: boolean
          created_at: string
          odds_multiplier: number
          reasoning: string | null
        }
        Insert: {
          id?: string
          user_id: string
          match_id: string
          league_id: string
          prediction_type: 'result' | 'exact_score' | 'btts'
          predicted_value: string
          risk_tier: 'low' | 'medium' | 'high'
          points_wagered: number
          points_won?: number | null
          double_or_nothing?: boolean
          resolved?: boolean
          created_at?: string
          odds_multiplier?: number
          reasoning?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          match_id?: string
          league_id?: string
          prediction_type?: 'result' | 'exact_score' | 'btts'
          predicted_value?: string
          risk_tier?: 'low' | 'medium' | 'high'
          points_wagered?: number
          points_won?: number | null
          double_or_nothing?: boolean
          resolved?: boolean
          created_at?: string
          odds_multiplier?: number
          reasoning?: string | null
        }
      }
      notifications: {
        Row: {
          id: string
          user_id: string
          type: 'bet_settled' | 'rival_bet' | 'league_join' | 'bet_starting' | 'achievement_earned'
          payload: Json
          read_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: 'bet_settled' | 'rival_bet' | 'league_join' | 'bet_starting' | 'achievement_earned'
          payload?: Json
          read_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          type?: 'bet_settled' | 'rival_bet' | 'league_join' | 'bet_starting' | 'achievement_earned'
          payload?: Json
          read_at?: string | null
          created_at?: string
        }
      }
      achievements: {
        Row: {
          id: string
          title: string
          description: string
          icon: string
          tier: 'bronze' | 'silver' | 'gold' | 'platinum'
          sort_order: number
        }
        Insert: {
          id: string
          title: string
          description: string
          icon: string
          tier: 'bronze' | 'silver' | 'gold' | 'platinum'
          sort_order?: number
        }
        Update: {
          id?: string
          title?: string
          description?: string
          icon?: string
          tier?: 'bronze' | 'silver' | 'gold' | 'platinum'
          sort_order?: number
        }
      }
      user_achievements: {
        Row: {
          user_id: string
          achievement_id: string
          earned_at: string
        }
        Insert: {
          user_id: string
          achievement_id: string
          earned_at?: string
        }
        Update: {
          user_id?: string
          achievement_id?: string
          earned_at?: string
        }
      }
      feed_reactions: {
        Row: {
          id: string
          prediction_id: string
          user_id: string
          emoji: string
          created_at: string
        }
        Insert: {
          id?: string
          prediction_id: string
          user_id: string
          emoji: string
          created_at?: string
        }
        Update: {
          id?: string
          prediction_id?: string
          user_id?: string
          emoji?: string
          created_at?: string
        }
      }
    }
  }
}

// Convenience types
export type User = Database['public']['Tables']['users']['Row']
export type League = Database['public']['Tables']['leagues']['Row']
export type LeagueMember = Database['public']['Tables']['league_members']['Row']
export type Match = Database['public']['Tables']['matches']['Row']
export type Prediction = Database['public']['Tables']['predictions']['Row']
export type FeedReaction = Database['public']['Tables']['feed_reactions']['Row']
export type Notification = Database['public']['Tables']['notifications']['Row']
export type NotificationType = Notification['type']
export type Achievement = Database['public']['Tables']['achievements']['Row']
export type UserAchievement = Database['public']['Tables']['user_achievements']['Row']

export type PredictionType = 'result' | 'exact_score' | 'btts'
export type RiskTier = 'low' | 'medium' | 'high'
export type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed'
