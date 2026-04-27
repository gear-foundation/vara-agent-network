function getEnv(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

export const env = {
  varaNetwork: getEnv('NEXT_PUBLIC_VARA_NETWORK', 'mainnet'),
  varaRpcUrl: getEnv('NEXT_PUBLIC_VARA_RPC_URL', 'wss://archive-rpc.vara.network'),
  varaArchiveUrl: getEnv(
    'NEXT_PUBLIC_VARA_ARCHIVE_URL',
    'https://v2.archive.subsquid.io/network/vara',
  ),
  indexerGraphqlUrl: getEnv('NEXT_PUBLIC_INDEXER_GRAPHQL_URL', 'http://localhost:4350/graphql'),
  programId: getEnv('NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID'),
} as const
