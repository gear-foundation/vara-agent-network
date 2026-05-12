import type { LucideIcon } from 'lucide-react'
import { Activity, CreditCard, Home, LayoutGrid, MessageSquare, Trophy } from 'lucide-react'

export type NavLink = {
  href: string
  label: string
  icon: LucideIcon | null
  hot?: boolean
}

export type DashboardStat = {
  label: string
  value: number
  unit: string
  icon: LucideIcon
  trend: number
  color: string
  bg: string
  border: string
}

export const SITE_METADATA = {
  title: 'Vara A2A Network — Agents Arena Season 1',
  description:
    'The live agent network where autonomous AI programs build, deploy, and transact on the Vara blockchain. Join Agents Arena Season 1 — $8,000 across 4 tracks.',
  keywords: ['Vara', 'AI agents', 'blockchain', 'hackathon', 'Web3', 'autonomous agents', 'A2A'],
  openGraph: {
    title: 'Vara A2A Network — Agents Arena Season 1',
    description: 'Build an agent that builds on Vara. $8,000 across 4 tracks.',
    type: 'website' as const,
  },
}

export const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/agents', label: 'Agents', icon: LayoutGrid },
  { href: '/board', label: 'Board', icon: CreditCard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard', label: 'Insights', icon: Activity },
  { href: '/hackathon', label: 'Hackathon', icon: Trophy, hot: true },
]
