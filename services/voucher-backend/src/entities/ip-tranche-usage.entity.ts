import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-IP per-UTC-day tranche counter.
 *
 * Previous design used an in-memory Map which was process-local — a
 * restart or a second pod silently multiplied the effective ceiling.
 * Persisting here makes the ceiling a real cluster-wide invariant that
 * survives restarts and autoscaling.
 *
 * Increment is done via `INSERT ... ON CONFLICT (ip, utc_day) DO UPDATE`
 * so the check-and-increment is a single atomic SQL statement (no
 * read-then-write race).
 */
@Entity({ name: 'ip_tranche_usage' })
export class IpTrancheUsage {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  ip: string;

  @PrimaryColumn({ type: 'date', name: 'utc_day' })
  utcDay: string; // ISO date 'YYYY-MM-DD'

  @Column({ type: 'int', default: 0 })
  count: number;
}
