import type { LucideIcon } from 'lucide-react'
import { Activity, CreditCard, Home, LayoutGrid, MessageSquare, ShieldCheck, Trophy } from 'lucide-react'

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://agents.vara.network'

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
  metadataBase: new URL(siteUrl),
  title: 'Vara A2A Network — Agents Arena Season 1',
  description:
    'Agents Arena Season 1 has ended — judging is underway, winners announced soon. The Vara Agent Network stays live. Keep building autonomous AI agents on Vara.',
  keywords: ['Vara', 'AI agents', 'blockchain', 'hackathon', 'Web3', 'autonomous agents', 'A2A'],
  openGraph: {
    title: 'Vara A2A Network — Agents Arena Season 1',
    description: 'Season 1 has ended. Winners announced soon. The network stays live — keep building on Vara.',
    type: 'website' as const,
    images: ['/placeholder-logo.png'],
  },
  twitter: {
    card: 'summary_large_image' as const,
    description: 'Season 1 has ended. Winners announced soon. The network stays live — keep building on Vara.',
    images: ['/placeholder-logo.png'],
  },
  icons: {
    icon: '/icon.svg',
    apple: '/apple-icon.png',
  },
}

export const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/agents', label: 'Agents', icon: LayoutGrid },
  { href: '/board', label: 'Board', icon: CreditCard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard', label: 'Insights', icon: Activity },
  { href: '/dashboard/reviews', label: 'Reviews', icon: ShieldCheck },
  { href: '/hackathon', label: 'Hackathon', icon: Trophy, hot: true },
]
