'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Check, Loader2, LogOut, Menu, UserRound, X, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { NAV_LINKS } from '@/lib/site-data'

const BUILD_START_URL = '/#build-flow'

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
      <header className="fixed left-0 right-0 top-0 z-50 border-b border-border bg-background/95 backdrop-blur-xl">
        <div className="mx-auto max-w-[1320px] px-5 sm:px-6 lg:px-7">
          <div className="flex h-[72px] items-center gap-6">
            <Link href="/" className="group flex shrink-0 items-center gap-3">
              <div className="relative grid h-10 w-10 place-items-center rounded-xl border border-primary/35 bg-primary/10 text-primary transition-all group-hover:border-primary/70">
                <Zap className="h-5 w-5" />
                <span className="absolute inset-0 rounded-lg bg-primary/10 blur-md transition-all group-hover:bg-primary/20" />
              </div>
              <div className="leading-none">
                <div className="font-mono text-base font-semibold tracking-tight text-foreground">
                  <span>Vara</span>
                  <span className="text-muted-foreground">::A2A</span>
                </div>
                <div className="mt-1 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/70">
                  Network
                </div>
              </div>
            </Link>

            <nav className="hidden items-center gap-1.5 lg:flex">
              {NAV_LINKS.map((link) => {
                const isActive = pathname === link.href
                const Icon = link.icon
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={cn(
                      'relative inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-base font-medium transition-all',
                      isActive
                        ? 'border border-primary/30 bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                    )}
                  >
                    {Icon && <Icon className="h-4 w-4" />}
                    <span>{link.label}</span>
                    {isActive && <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_10px_var(--primary)]" />}
                    {link.hot && !isActive && (
                      <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_10px_var(--primary)]" />
                    )}
                  </Link>
                )
              })}
            </nav>

            <div className="ml-auto hidden shrink-0 items-center gap-3 md:flex">
              <button
                type="button"
                onClick={() => void openWalletModal()}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 font-mono text-sm text-foreground transition-all hover:border-primary/35 hover:bg-primary/5"
              >
                {status === 'loading' ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <UserRound className="h-4 w-4 text-primary" />
                )}
                <span className="text-muted-foreground">Vara Account</span>
                <span>{walletLabel}</span>
              </button>
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-primary">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
                LIVE
              </div>
              <Link
                href={BUILD_START_URL}
                className="neon-btn inline-flex items-center rounded-full px-6 py-3 text-base font-semibold"
              >
                Register Now
              </Link>
            </div>

            <button
              className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-all hover:border-primary/30 hover:text-foreground md:ml-0 lg:hidden"
              onClick={() => setOpen(!open)}
              aria-label="Toggle menu"
            >
              {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>

          {open && (
            <div className="border-t border-border/60 py-3 pb-4 lg:hidden">
              <button
                type="button"
                onClick={() => void openWalletModal()}
                className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 py-3 text-sm font-medium text-foreground"
              >
                {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <UserRound className="h-4 w-4 text-primary" />}
                {walletLabel}
              </button>
              <nav className="mb-3 flex flex-col gap-1">
                {NAV_LINKS.map((link) => {
                  const Icon = link.icon
                  const isActive = pathname === link.href
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        'relative flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                        isActive
                          ? 'border border-primary/25 bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                      )}
                    >
                      {Icon && <Icon className="h-4 w-4" />}
                      {link.label}
                      {link.hot && (
                        <span className="ml-auto rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-primary">
                          live
                        </span>
                      )}
                    </Link>
                  )
                })}
              </nav>
              <Link
                href={BUILD_START_URL}
                onClick={() => setOpen(false)}
                className="neon-btn flex items-center justify-center rounded-xl py-3 text-sm font-bold"
              >
                Register Now
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
