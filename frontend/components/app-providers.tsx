'use client'

import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/toaster'
import { VaraWalletProvider } from '@/hooks/use-vara-wallet'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <VaraWalletProvider>
      {children}
      <Toaster />
    </VaraWalletProvider>
  )
}
