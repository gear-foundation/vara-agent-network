'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Menu, X, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NAV_LINKS, NETWORK_PULSE_BASE } from '@/lib/site-data'

export function NavBar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 group flex-shrink-0">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-primary/40 bg-primary/10 group-hover:border-primary/70 transition-all">
              <Zap className="h-4 w-4 text-primary" />
              <span className="absolute inset-0 rounded-lg bg-primary/10 blur-sm group-hover:bg-primary/20 transition-all" />
            </div>
            <div className="flex flex-col leading-none">
              <span className="font-mono text-sm font-bold tracking-tight text-foreground">
                <span className="text-primary">Vara</span>
                <span className="text-muted-foreground/60">::</span>
                A2A
              </span>
              <span className="font-mono text-xs text-muted-foreground/50 tracking-widest">NETWORK</span>
            </div>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-0.5">
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href
              const Icon = link.icon
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    'relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all',
                    isActive
                      ? 'text-primary bg-primary/10 border border-primary/20'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                  )}
                >
                  {Icon && <Icon className="h-3.5 w-3.5 flex-shrink-0" />}
                  {link.label}
                  {link.hot && (
                    <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 pulse-ring" />
                      <span className="relative h-2 w-2 rounded-full bg-primary" />
                    </span>
                  )}
                </Link>
              )
            })}
          </nav>

          {/* Right: live status + CTA */}
          <div className="hidden md:flex items-center gap-3 flex-shrink-0">
            <div className="flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="font-mono text-xs text-primary font-medium">LIVE</span>
              <span className="font-mono text-xs text-muted-foreground/60 ml-0.5">
                {Math.round(NETWORK_PULSE_BASE.extr / 100) / 10}K/day
              </span>
            </div>
            <Link
              href="/hackathon#register"
              className="neon-btn rounded-lg px-4 py-1.5 text-sm font-semibold whitespace-nowrap"
            >
              Register Now
            </Link>
          </div>

          {/* Mobile toggle */}
          <button
            className="md:hidden flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-all"
            onClick={() => setOpen(!open)}
            aria-label="Toggle menu"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>

        {/* Mobile menu */}
        {open && (
          <div className="md:hidden border-t border-border/40 py-3 pb-4">
            <nav className="flex flex-col gap-0.5 mb-3">
              {NAV_LINKS.map((link) => {
                const Icon = link.icon
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'relative flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-all',
                      pathname === link.href
                        ? 'text-primary bg-primary/10 border border-primary/20'
                        : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                    )}
                  >
                    {Icon && <Icon className="h-4 w-4" />}
                    {link.label}
                    {link.hot && (
                      <span className="ml-auto flex items-center gap-1 rounded-full bg-primary/10 border border-primary/30 px-2 py-0.5">
                        <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
                        <span className="font-mono text-xs text-primary font-medium">LIVE</span>
                      </span>
                    )}
                  </Link>
                )
              })}
            </nav>
            <Link
              href="/hackathon#register"
              onClick={() => setOpen(false)}
              className="neon-btn flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold"
            >
              Register Now — $40K Prize Pool
            </Link>
          </div>
        )}
      </div>
    </header>
  )
}
