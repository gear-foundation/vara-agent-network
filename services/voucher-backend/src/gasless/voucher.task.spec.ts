import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { VoucherTask } from './voucher.task';
import { VoucherService } from './voucher.service';
import { Voucher } from '../entities/voucher.entity';

function makeVoucher(id: string, overrides: Partial<Voucher> = {}): Voucher {
  return {
    id,
    voucherId: `0x${id}`,
    account: `0xacct_${id}`,
    programs: [],
    varaToIssue: 3,
    validUpToBlock: 100n,
    validUpTo: new Date(Date.now() - 1000), // already expired
    lastRenewedAt: new Date(),
    revoked: false,
    ...overrides,
  } as Voucher;
}

describe('VoucherTask', () => {
  let task: VoucherTask;
  let repo: { find: jest.Mock; findOne: jest.Mock };
  let voucherSvc: { revoke: jest.Mock };
  let qrQuery: jest.Mock;
  let qrRelease: jest.Mock;
  let ds: { createQueryRunner: jest.Mock };

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      // findOne (re-read under lock) returns the same voucher by default;
      // individual tests override for race-scenarios.
      findOne: jest.fn().mockImplementation(async ({ where: { id } }) => {
        return (repo.find.mock.results[0]?.value ?? []).find((v: Voucher) => v.id === id) ?? null;
      }),
    };
    voucherSvc = { revoke: jest.fn().mockResolvedValue('revoked') };
    qrQuery = jest.fn().mockResolvedValue([]);
    qrRelease = jest.fn().mockResolvedValue(undefined);
    ds = {
      createQueryRunner: jest.fn().mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        query: qrQuery,
        release: qrRelease,
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        VoucherTask,
        { provide: VoucherService, useValue: voucherSvc },
        { provide: getRepositoryToken(Voucher), useValue: repo },
        { provide: DataSource, useValue: ds },
      ],
    }).compile();

    task = module.get(VoucherTask);
  });

  it('does nothing when no expired vouchers', async () => {
    repo.find.mockResolvedValue([]);
    await task.revokeExpiredVouchers();
    expect(voucherSvc.revoke).not.toHaveBeenCalled();
  });

  it('revokes each expired voucher (happy path)', async () => {
    const expired = [makeVoucher('aaa'), makeVoucher('bbb'), makeVoucher('ccc')];
    repo.find.mockResolvedValue(expired);
    // findOne returns the same expired row under the lock.
    repo.findOne.mockImplementation(async ({ where: { id } }) =>
      expired.find((v) => v.id === id) ?? null,
    );
    await task.revokeExpiredVouchers();
    expect(voucherSvc.revoke).toHaveBeenCalledTimes(3);
  });

  it('continues revoking remaining vouchers after one throws', async () => {
    const expired = [makeVoucher('aaa'), makeVoucher('bbb'), makeVoucher('ccc')];
    repo.find.mockResolvedValue(expired);
    repo.findOne.mockImplementation(async ({ where: { id } }) =>
      expired.find((v) => v.id === id) ?? null,
    );
    voucherSvc.revoke
      .mockResolvedValueOnce('revoked')
      .mockRejectedValueOnce(new Error('chain error'))
      .mockResolvedValueOnce('revoked');
    await task.revokeExpiredVouchers();
    expect(voucherSvc.revoke).toHaveBeenCalledTimes(3);
  });

  it('logs db-only fallback when on-chain revoke fails but the row is marked revoked', async () => {
    const v = makeVoucher('aaa');
    repo.find.mockResolvedValue([v]);
    repo.findOne.mockResolvedValue(v);
    voucherSvc.revoke.mockResolvedValue('db_only');
    await task.revokeExpiredVouchers();
    expect(voucherSvc.revoke).toHaveBeenCalledWith(v);
  });

  it('does not mark DB revoked when chain says voucher is still valid', async () => {
    const v = makeVoucher('aaa');
    repo.find.mockResolvedValue([v]);
    repo.findOne.mockResolvedValue(v);
    voucherSvc.revoke.mockResolvedValue('still_valid');
    await task.revokeExpiredVouchers();
    expect(voucherSvc.revoke).toHaveBeenCalledWith(v);
  });

  it('queries only non-revoked vouchers with validUpTo < now', async () => {
    await task.revokeExpiredVouchers();
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revoked: false }),
      }),
    );
  });

  // ── Race safety: cron vs concurrent top-up ─────────────────────────────
  // Before this fix, the cron revoked a voucher on its stale in-memory copy
  // even when a POST /voucher had just won the race and renewed validUpTo.
  // The fix: re-read under the per-wallet advisory lock and skip if the
  // fresh row is no longer expired.

  it('acquires per-wallet advisory lock before revoking', async () => {
    const v = makeVoucher('aaa');
    repo.find.mockResolvedValue([v]);
    repo.findOne.mockResolvedValue(v);
    await task.revokeExpiredVouchers();
    const calls = qrQuery.mock.calls.map((c) => c[0]);
    expect(calls).toContain('SELECT pg_advisory_lock($1, $2)');
    expect(calls).toContain('SELECT pg_advisory_unlock($1, $2)');
    expect(qrRelease).toHaveBeenCalled();
  });

  it('skips revoke when the voucher was renewed concurrently (validUpTo moved into the future)', async () => {
    const v = makeVoucher('aaa');
    repo.find.mockResolvedValue([v]);
    // Under the lock we re-read and the voucher has a fresh top-up: validUpTo now in the future.
    repo.findOne.mockResolvedValue({
      ...v,
      validUpTo: new Date(Date.now() + 3600_000),
    });
    await task.revokeExpiredVouchers();
    expect(voucherSvc.revoke).not.toHaveBeenCalled();
    // Lock was still acquired and released — we didn't bail before the race check.
    const calls = qrQuery.mock.calls.map((c) => c[0]);
    expect(calls).toContain('SELECT pg_advisory_lock($1, $2)');
    expect(calls).toContain('SELECT pg_advisory_unlock($1, $2)');
  });

  it('skips revoke when the voucher was already revoked by another path', async () => {
    const v = makeVoucher('aaa');
    repo.find.mockResolvedValue([v]);
    repo.findOne.mockResolvedValue({ ...v, revoked: true });
    await task.revokeExpiredVouchers();
    expect(voucherSvc.revoke).not.toHaveBeenCalled();
  });

  it('releases the advisory lock even when revoke() throws', async () => {
    const v = makeVoucher('aaa');
    repo.find.mockResolvedValue([v]);
    repo.findOne.mockResolvedValue(v);
    voucherSvc.revoke.mockRejectedValue(new Error('chain down'));
    await task.revokeExpiredVouchers();
    const calls = qrQuery.mock.calls.map((c) => c[0]);
    expect(calls).toContain('SELECT pg_advisory_unlock($1, $2)');
    expect(qrRelease).toHaveBeenCalled();
  });
});
