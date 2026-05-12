import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import {
  GaslessProgram,
  GaslessProgramStatus,
} from './entities/gasless-program.entity';
import { Voucher } from './entities/voucher.entity';

config();

/**
 * Vara Agent Network program whitelist for the voucher backend.
 *
 * Hourly-tranche: POST /voucher accepts programs: string[] and
 * batch-registers all listed programs on a single voucher. First POST funds
 * the voucher with `HOURLY_TRANCHE_VARA` (env var, default 500) for the
 * TRANCHE_DURATION_SEC duration. Each subsequent POST after TRANCHE_INTERVAL_SEC
 * adds another tranche AND extends the duration (sliding 24h window).
 *
 * `varaToIssue` and `weight` on each row are retained for schema compatibility
 * but are no longer read by `gasless.service.ts` — the per-tranche amount is
 * applied uniformly across all programs.
 */
const PROGRAMS = [
  {
    name: 'VaraAgentNetwork',
    address:
      '0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3',
    weight: 1,
    duration: 86400, // 24h
    oneTime: false,
  },
];

async function seed() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    entities: [GaslessProgram, Voucher],
    synchronize: false,
  });

  await ds.initialize();
  const repo = ds.getRepository(GaslessProgram);

  const trancheVara = Number(process.env.HOURLY_TRANCHE_VARA || '500');

  for (const p of PROGRAMS) {
    // varaToIssue is inactive now (kept for schema compat).
    // Display value tracks trancheVara so the DB state is self-documenting.
    const varaToIssue = trancheVara;
    const existing = await repo.findOneBy({ address: p.address });

    if (existing) {
      existing.weight = p.weight;
      existing.varaToIssue = varaToIssue;
      existing.duration = p.duration;
      await repo.save(existing);
      console.log(`[update] ${p.name} ${p.address.slice(0, 12)}... (tranche=${trancheVara} VARA)`);
      continue;
    }

    await repo.save({
      name: p.name,
      address: p.address,
      varaToIssue,
      weight: p.weight,
      duration: p.duration,
      status: GaslessProgramStatus.Enabled,
      oneTime: p.oneTime,
      createdAt: new Date(),
    });
    console.log(`[seed] ${p.name} ${p.address.slice(0, 12)}... (tranche=${trancheVara} VARA)`);
  }

  console.log('Seed complete.');
  await ds.destroy();
}

seed().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
