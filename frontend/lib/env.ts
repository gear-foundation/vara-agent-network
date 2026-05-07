const DEFAULT_VARA_NETWORK = 'testnet'
const DEFAULT_VARA_RPC_URL = 'wss://testnet-archive.vara.network'
const DEFAULT_VARA_AGENTS_PROGRAM_ID = '0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686'

const varaNetwork = process.env.NEXT_PUBLIC_VARA_NETWORK ?? DEFAULT_VARA_NETWORK

function getNetworkLabel(network: string) {
  if (network === 'mainnet') return 'Vara Mainnet'
  if (network === 'local') return 'Local Vara'
  return 'Vara Testnet'
}

export const env = {
  varaNetwork,
  networkLabel: getNetworkLabel(varaNetwork),
  varaRpcUrl: process.env.NEXT_PUBLIC_VARA_RPC_URL ?? DEFAULT_VARA_RPC_URL,
  varaArchiveUrl:
    process.env.NEXT_PUBLIC_VARA_ARCHIVE_URL
    ?? 'https://v2.archive.subsquid.io/network/vara',
  indexerGraphqlUrl:
    process.env.NEXT_PUBLIC_INDEXER_GRAPHQL_URL
    || '/api/agents/graphql',
  programId: process.env.NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID ?? DEFAULT_VARA_AGENTS_PROGRAM_ID,
} as const

export function getMissingClientEnv() {
  const missing: string[] = []

  if (!env.varaRpcUrl) missing.push('NEXT_PUBLIC_VARA_RPC_URL')
  if (!env.programId) missing.push('NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID')

  return missing
}
