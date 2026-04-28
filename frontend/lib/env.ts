const varaNetwork = process.env.NEXT_PUBLIC_VARA_NETWORK ?? 'mainnet'

function getNetworkLabel(network: string) {
  if (network === 'mainnet') return 'Vara Mainnet'
  if (network === 'local') return 'Local Vara'
  return 'Vara Testnet'
}

export const env = {
  varaNetwork,
  networkLabel: getNetworkLabel(varaNetwork),
  varaRpcUrl: process.env.NEXT_PUBLIC_VARA_RPC_URL ?? 'wss://archive-rpc.vara.network',
  varaArchiveUrl:
    process.env.NEXT_PUBLIC_VARA_ARCHIVE_URL
    ?? 'https://v2.archive.subsquid.io/network/vara',
  indexerGraphqlUrl:
    process.env.NEXT_PUBLIC_INDEXER_GRAPHQL_URL
    ?? 'http://localhost:4350/graphql',
  programId: process.env.NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID ?? '',
} as const

export function getMissingClientEnv() {
  const missing: string[] = []

  if (!env.varaRpcUrl) missing.push('NEXT_PUBLIC_VARA_RPC_URL')
  if (!env.programId) missing.push('NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID')

  return missing
}
