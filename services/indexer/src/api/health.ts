const MAX_HEALTH_LAG_BLOCKS = 100;

export function rpcHttpUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.toString();
}

export async function getChainHead(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcHttpUrl(rpcUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "chain_getHeader", params: [] }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Vara RPC returned HTTP ${response.status}`);

  const body = await response.json() as { result?: { number?: string } };
  const head = Number.parseInt(body.result?.number ?? "", 16);
  if (!Number.isSafeInteger(head)) throw new Error("Vara RPC returned an invalid chain head");
  return head;
}

export function indexerHealth(lastProcessedBlock: number, chainHead: number) {
  const lag = chainHead - lastProcessedBlock;
  return {
    ok: lag >= 0 && lag <= MAX_HEALTH_LAG_BLOCKS,
    chainHead,
    lastProcessedBlock,
    lag,
    maxLag: MAX_HEALTH_LAG_BLOCKS,
  };
}
