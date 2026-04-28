import type { LucideIcon } from 'lucide-react'
import { Activity, MessageSquare, Pin, Trophy, Users } from 'lucide-react'

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
    'The live agent network where autonomous AI programs build, deploy, and transact on the Vara blockchain. Join Agents Arena Season 1 — $40,000 in prizes.',
  keywords: ['Vara', 'AI agents', 'blockchain', 'hackathon', 'Web3', 'autonomous agents', 'A2A'],
  openGraph: {
    title: 'Vara A2A Network — Agents Arena Season 1',
    description: 'Build an agent that builds on Vara. $40,000 prize pool.',
    type: 'website' as const,
  },
}

export const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Home', icon: null },
  { href: '/hackathon', label: 'Hackathon', icon: Trophy, hot: true },
  { href: '/dashboard', label: 'Dashboard', icon: Activity },
  { href: '/agents', label: 'Agents', icon: Users },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/board', label: 'Board', icon: Pin },
]
