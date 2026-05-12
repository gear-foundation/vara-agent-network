// Bounded backfill benchmark. Measures fetch+decode cost only (no handler DB
// writes) so the comparison isolates the runtime-version cache impact.
// Usage: VARA_RPC_URL=wss://testnet-archive.vara.network \
//   tsx scripts/bench-backfill.ts <numBlocks>
//
// Cursor-write safety: this script auto-sets PROCESSOR_DISABLE_CURSOR_WRITES
// so a fetch-only run against any DATABASE_URL never advances processor_cursor
// without writing projections. Set PROCESSOR_DISABLE_CURSOR_WRITES=false
// explicitly to override (not recommended). The env var is set BEFORE the
// dynamic imports below, since static imports are hoisted in ESM and config.ts
// reads env at module evaluation.

process.env.PROCESSOR_DISABLE_CURSOR_WRITES =
  process.env.PROCESSOR_DISABLE_CURSOR_WRITES ?? "true";

const numBlocks = Number.parseInt(process.argv[2] ?? "500", 10);
if (!Number.isFinite(numBlocks) || numBlocks <= 0) {
  console.error("usage: tsx scripts/bench-backfill.ts <numBlocks>");
  process.exit(1);
}

const { createProcessor } = await import("../src/processor.js");
const { requireProcessorConfig } = await import("../src/config.js");
type BlockContext = import("../src/helpers/types.js").BlockContext;

const processorConfig = requireProcessorConfig();

if (!processorConfig.processorDisableCursorWrites) {
  console.error(
    "[bench] WARNING: PROCESSOR_DISABLE_CURSOR_WRITES is not true; this run WILL advance processor_cursor in:",
    processorConfig.databaseUrl,
  );
}

// No-op onBlock — we are measuring fetch cost only.
const processor = await createProcessor({
  onBlock: async (_ctx: BlockContext) => {},
});

const startBlock = processorConfig.startBlock;
const endBlock = startBlock + numBlocks - 1;
const actualStart = await processor.resumePoint();

console.log(
  `[bench] range ${actualStart}..${endBlock} (${endBlock - actualStart + 1} blocks; configured numBlocks=${numBlocks} from start=${startBlock})`,
);
console.log(`[bench] rpc=${processorConfig.varaRpcUrl}`);
console.log(`[bench] fetch_concurrency=${processorConfig.processorBackfillFetchConcurrency}`);
console.log(
  `[bench] cursor_writes_disabled=${processorConfig.processorDisableCursorWrites}`,
);

const t0 = Date.now();
await processor.runBackfill(endBlock);
const elapsedMs = Date.now() - t0;

const actualBlocks = endBlock - actualStart + 1;
const msPerBlock = elapsedMs / actualBlocks;
console.log(`[bench] DONE ${actualBlocks} blocks in ${elapsedMs}ms`);
console.log(`[bench] ${msPerBlock.toFixed(1)}ms/block   (${(1000 / msPerBlock).toFixed(2)} blk/s)`);

await processor.stop();
process.exit(0);
