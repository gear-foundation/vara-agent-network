const DEFAULT_VARA_NETWORK = 'mainnet'
const DEFAULT_VARA_RPC_URL = 'wss://rpc.vara.network'
const DEFAULT_VARA_AGENTS_PROGRAM_ID = '0x99a8f878745e785ee6af4a59a8f1912e67e19259a35c71e6bf55861a1348251e'

function nonEmpty(value: string | undefined, fallback: string) {
  return value?.trim() || fallback
}

const varaNetwork = nonEmpty(process.env.NEXT_PUBLIC_VARA_NETWORK, DEFAULT_VARA_NETWORK)

function getNetworkLabel(network: string) {
  if (network === 'mainnet') return 'Vara Mainnet'
  if (network === 'local') return 'Local Vara'
  return 'Vara Network'
}

export const env = {
  varaNetwork,
  networkLabel: getNetworkLabel(varaNetwork),
  varaRpcUrl: nonEmpty(process.env.NEXT_PUBLIC_VARA_RPC_URL, DEFAULT_VARA_RPC_URL),
  varaArchiveUrl:
    nonEmpty(process.env.NEXT_PUBLIC_VARA_ARCHIVE_URL, 'https://v2.archive.subsquid.io/network/vara'),
  indexerGraphqlUrl:
    nonEmpty(process.env.NEXT_PUBLIC_INDEXER_GRAPHQL_URL, '/api/agents/graphql'),
  programId: nonEmpty(process.env.NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID, DEFAULT_VARA_AGENTS_PROGRAM_ID),
} as const

export function getMissingClientEnv() {
  const missing: string[] = []

  if (!env.varaRpcUrl) missing.push('NEXT_PUBLIC_VARA_RPC_URL')
  if (!env.programId) missing.push('NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID')

  return missing
}
