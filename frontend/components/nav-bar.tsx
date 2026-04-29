'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Check, Loader2, LogOut, Menu, PlugZap, UserRound, X, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { NAV_LINKS } from '@/lib/site-data'

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function NavBar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [walletModalOpen, setWalletModalOpen] = useState(false)
  const { status, account, accounts, participant, connect, disconnect, selectAccount } = useVaraWallet()

  const walletLabel = (() => {
    if (status === 'loading') return 'Wallets...'
    if (status === 'no_extension') return 'Install Wallet'
    if (!account) return 'Connect Wallet'
    if (participant?.handle) return `@${participant.handle}`
    if (account.name) return account.name
    return shortenAddress(account.address)
  })()

  useEffect(() => {
    if (!walletModalOpen) return

    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previous
    }
  }, [walletModalOpen])

  const openWalletModal = async () => {
    if (!account) {
      await connect()
      return
    }

    setWalletModalOpen(true)
  }

  const handleAccountPick = (address: string) => {
    selectAccount(address)
    setWalletModalOpen(false)
  }

  return (
    <>
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
            <button
              type="button"
              onClick={() => void openWalletModal()}
              className="flex items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-3 py-1.5 text-xs font-mono text-accent transition-all hover:border-accent/40"
            >
              {status === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlugZap className="h-3.5 w-3.5" />
              )}
              <span>{walletLabel}</span>
            </button>
            <div className="flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="font-mono text-xs text-primary font-medium">LIVE</span>
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
            <button
              type="button"
              onClick={() => void openWalletModal()}
              className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl border border-accent/20 bg-accent/5 px-3 py-3 text-sm font-medium text-accent"
            >
              {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
              {walletLabel}
            </button>
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

      {walletModalOpen && account && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close wallet picker"
            className="absolute inset-0 bg-background/55 backdrop-blur-md"
            onClick={() => setWalletModalOpen(false)}
          />
          <div className="relative z-[81] w-full max-w-md rounded-3xl border border-border/80 bg-card/95 p-6 shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Wallet</div>
                <h3 className="mt-2 text-xl font-semibold text-foreground">Choose account</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Select which connected Vara account should sign actions in the app.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setWalletModalOpen(false)}
                className="rounded-full border border-border p-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2">
              {accounts.map((item) => {
                const isSelected = item.address === account.address
                return (
                  <button
                    key={item.address}
                    type="button"
                    onClick={() => handleAccountPick(item.address)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition-all',
                      isSelected
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-border bg-background/70 hover:border-primary/20 hover:bg-secondary/30'
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <UserRound className={cn('h-4 w-4', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                        <span className="truncate font-medium text-foreground">
                          {item.name || 'Unnamed account'}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">
                        {shortenAddress(item.address)}
                      </div>
                    </div>
                    {isSelected && <Check className="h-4 w-4 text-primary" />}
                  </button>
                )
              })}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                {participant?.handle ? `Registered as @${participant.handle}` : 'Selected account has no registered participant'}
              </div>
              <button
                type="button"
                onClick={() => {
                  disconnect()
                  setWalletModalOpen(false)
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <LogOut className="h-4 w-4" />
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
