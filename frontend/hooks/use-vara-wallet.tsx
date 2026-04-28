'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getParticipant, registerParticipant, type ParticipantRecord, type WalletAccount } from '@/lib/vara-program'
import { toast } from '@/hooks/use-toast'
import { formatDappError, logError, logInfo } from '@/lib/debug'

type WalletStatus =
  | 'loading'
  | 'no_extension'
  | 'disconnected'
  | 'connected'
  | 'error'

type VaraWalletContextValue = {
  status: WalletStatus
  accounts: WalletAccount[]
  account: WalletAccount | null
  participant: ParticipantRecord | null
  participantLoading: boolean
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
  selectAccount: (address: string) => void
  refreshParticipant: () => Promise<void>
  registerCurrentParticipant: (handle: string, github: string) => Promise<void>
}

const STORAGE_KEY = 'vara-a2a-wallet-address'

const VaraWalletContext = createContext<VaraWalletContextValue | null>(null)

async function loadExtensionAccounts() {
  const { web3Enable, web3Accounts } = await import('@polkadot/extension-dapp')
  const extensions = await web3Enable('Vara A2A Network')

  if (extensions.length === 0) {
    return {
      hasExtension: false,
      accounts: [] as WalletAccount[],
    }
  }

  const accounts = await web3Accounts()

  return {
    hasExtension: true,
    accounts: accounts.map((account) => ({
      address: account.address,
      name: account.meta.name,
      source: account.meta.source,
    })),
  }
}

export function VaraWalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>('loading')
  const [accounts, setAccounts] = useState<WalletAccount[]>([])
  const [account, setAccount] = useState<WalletAccount | null>(null)
  const [participant, setParticipant] = useState<ParticipantRecord | null>(null)
  const [participantLoading, setParticipantLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectAccount = useCallback((address: string) => {
    const next = accounts.find((item) => item.address === address) ?? null
    if (!next) return

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next.address)
    }

    setAccount(next)
  }, [accounts])

  const disconnect = useCallback(() => {
    setAccount(null)
    setParticipant(null)
    setStatus(accounts.length > 0 ? 'disconnected' : 'no_extension')
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  }, [accounts.length])

  const refreshParticipant = useCallback(async () => {
    if (!account) {
      setParticipant(null)
      return
    }

    setParticipantLoading(true)
    try {
      const next = await getParticipant(account.address)
      setParticipant(next)
    } catch (err) {
      logError('wallet', 'failed to refresh participant', err, { account: account.address })
      setError(formatDappError(err))
    } finally {
      setParticipantLoading(false)
    }
  }, [account])

  const connect = useCallback(async () => {
    setStatus('loading')
    setError(null)

    try {
      logInfo('wallet', 'enabling extension')
      const { hasExtension, accounts: nextAccounts } = await loadExtensionAccounts()
      logInfo('wallet', 'extension accounts loaded', { count: nextAccounts.length })
      setAccounts(nextAccounts)

      if (!hasExtension) {
        setStatus('no_extension')
        return
      }

      if (nextAccounts.length === 0) {
        setAccount(null)
        setStatus('disconnected')
        return
      }

      const remembered = typeof window !== 'undefined'
        ? window.localStorage.getItem(STORAGE_KEY)
        : null
      const selected = nextAccounts.find((item) => item.address === remembered) ?? nextAccounts[0] ?? null

      setAccount(selected)
      if (selected && typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, selected.address)
      }
      setStatus('connected')
    } catch (err) {
      logError('wallet', 'connect failed', err)
      setStatus('error')
      setError(formatDappError(err))
    }
  }, [])

  const registerCurrentParticipant = useCallback(async (handle: string, github: string) => {
    if (!account) throw new Error('Connect wallet first')

    logInfo('wallet', 'register current participant', {
      account: account.address,
      handle,
    })
    await registerParticipant(account, handle, github)
    await refreshParticipant()
  }, [account, refreshParticipant])

  useEffect(() => {
    void connect()
  }, [connect])

  useEffect(() => {
    if (!account) {
      setParticipant(null)
      return
    }

    void refreshParticipant()
  }, [account, refreshParticipant])

  useEffect(() => {
    if (status !== 'no_extension') return
    toast({
      title: 'No Vara wallet extension found',
      description: 'Install SubWallet, Polkadot.js, or Talisman to sign on-chain actions.',
    })
  }, [status])

  const value = useMemo<VaraWalletContextValue>(() => ({
    status,
    accounts,
    account,
    participant,
    participantLoading,
    error,
    connect,
    disconnect,
    selectAccount,
    refreshParticipant,
    registerCurrentParticipant,
  }), [
    status,
    accounts,
    account,
    participant,
    participantLoading,
    error,
    connect,
    disconnect,
    selectAccount,
    refreshParticipant,
    registerCurrentParticipant,
  ])

  return (
    <VaraWalletContext.Provider value={value}>
      {children}
    </VaraWalletContext.Provider>
  )
}

export function useVaraWallet() {
  const value = useContext(VaraWalletContext)

  if (!value) {
    throw new Error('useVaraWallet must be used inside VaraWalletProvider')
  }

  return value
}
