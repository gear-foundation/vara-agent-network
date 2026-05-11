// Bounded backfill benchmark. Measures fetch+decode cost only (no handler DB
// writes) so the comparison isolates the runtime-version cache impact.
// Usage: VARA_RPC_URL=wss://testnet-archive.vara.network \
//   tsx scripts/bench-backfill.ts <numBlocks>
import { createProcessor } from "../src/processor.js";
import { requireProcessorConfig } from "../src/config.js";
import type { BlockContext } from "../src/helpers/types.js";

const numBlocks = Number.parseInt(process.argv[2] ?? "500", 10);
if (!Number.isFinite(numBlocks) || numBlocks <= 0) {
  console.error("usage: tsx scripts/bench-backfill.ts <numBlocks>");
  process.exit(1);
}

const processorConfig = requireProcessorConfig();

// No-op onBlock — we are measuring fetch cost only.
const processor = await createProcessor({
  onBlock: async (_ctx: BlockContext) => {},
});

const startBlock = processorConfig.startBlock;
const endBlock = startBlock + numBlocks - 1;
const actualStart = await processor.resumePoint();

console.log(`[bench] range ${actualStart}..${endBlock} (${endBlock - actualStart + 1} blocks; configured numBlocks=${numBlocks} from start=${startBlock})`);
console.log(`[bench] rpc=${processorConfig.varaRpcUrl}`);
console.log(`[bench] fetch_concurrency=${processorConfig.processorBackfillFetchConcurrency}`);

const t0 = Date.now();
await processor.runBackfill(endBlock);
const elapsedMs = Date.now() - t0;

const actualBlocks = endBlock - actualStart + 1;
const msPerBlock = elapsedMs / actualBlocks;
console.log(`[bench] DONE ${actualBlocks} blocks in ${elapsedMs}ms`);
console.log(`[bench] ${msPerBlock.toFixed(1)}ms/block   (${(1000 / msPerBlock).toFixed(2)} blk/s)`);

await processor.stop();
process.exit(0);
