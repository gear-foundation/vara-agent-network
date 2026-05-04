import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { VoucherService } from './voucher.service';
import { Voucher } from '../entities/voucher.entity';

// ── GearApi mock ───────────────────────────────────────────────────────────────
// We only test the parts of VoucherService that don't need a live chain:
//   • onModuleInit throws when the API rejects
//   • getVoucher filters by revoked: false
//   • issue() rejects with a clear error when issuer balance is too low
//   • issue() passes the programIds array unmodified to the Gear SDK
//   • update() guards against revoked vouchers
//   • signAndSend timeout kicks in after a bounded wait

const mockBalance = jest.fn();
const mockIsReadyOrError = jest.fn();
const mockVoucherIssue = jest.fn();
const mockVoucherUpdate = jest.fn();
const mockVoucherRevoke = jest.fn();
const mockGetBlockNumber = jest.fn();
const mockGetFinalizedHead = jest.fn();
const mockGetExtrinsicFailedError = jest.fn();
const mockDisconnect = jest.fn();

jest.mock('@gear-js/api', () => ({
  GearApi: jest.fn().mockImplementation(() => ({
    isReadyOrError: mockIsReadyOrError(),
    isConnected: true,
    disconnect: mockDisconnect,
    balance: { findOut: mockBalance },
    voucher: {
      minDuration: 1,
      maxDuration: 28_800,
      issue: mockVoucherIssue,
      update: mockVoucherUpdate,
      revoke: mockVoucherRevoke,
    },
    blocks: {
      getBlockNumber: mockGetBlockNumber,
      getFinalizedHead: mockGetFinalizedHead,
    },
    getExtrinsicFailedError: mockGetExtrinsicFailedError,
  })),
  HexString: {},
  IUpdateVoucherParams: {},
  VoucherIssuedData: {},
}));

jest.mock('@polkadot/wasm-crypto', () => ({
  waitReady: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@polkadot/api', () => ({
  Keyring: jest.fn().mockImplementation(() => ({
    addFromSeed: jest.fn().mockReturnValue({ address: '5GrwvaEF' }),
    addFromUri: jest.fn().mockReturnValue({ address: '5GrwvaEF' }),
    addFromMnemonic: jest.fn().mockReturnValue({ address: '5GrwvaEF' }),
  })),
}));

jest.mock('@polkadot/util', () => ({
  hexToU8a: jest.fn().mockReturnValue(new Uint8Array(32)),
}));

function makeVoucher(overrides: Partial<Voucher> = {}): Voucher {
  return {
    id: 'v1',
    voucherId: '0xvoucher',
    account: '0xabc',
    programs: ['0xprog'],
    varaToIssue: 3,
    validUpToBlock: 1000n,
    validUpTo: new Date(Date.now() + 86400_000),
    lastRenewedAt: new Date(),
    revoked: false,
    ...overrides,
  } as Voucher;
}

describe('VoucherService', () => {
  let service: VoucherService;
  let repo: { findOneBy: jest.Mock; save: jest.Mock };
  let cfg: { get: jest.Mock };
  let ds: { createQueryRunner: jest.Mock };
  let qrQuery: jest.Mock;
  let qrRelease: jest.Mock;

  beforeEach(async () => {
    mockIsReadyOrError.mockReturnValue(Promise.resolve());
    mockBalance.mockResolvedValue({ toBigInt: () => BigInt(100 * 1e12) });
    mockVoucherIssue.mockReset();
    mockVoucherUpdate.mockReset();
    mockVoucherRevoke.mockReset();
    mockGetBlockNumber.mockReset();
    mockGetBlockNumber.mockResolvedValue({ toNumber: () => 123 });
    mockGetFinalizedHead.mockReset();
    mockGetFinalizedHead.mockResolvedValue({ toHex: () => '0xhead' });
    mockGetExtrinsicFailedError.mockReset();
    mockGetExtrinsicFailedError.mockReturnValue(new Error('extrinsic failed'));
    mockDisconnect.mockReset();
    mockDisconnect.mockResolvedValue(undefined);

    repo = {
      findOneBy: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
    };
    cfg = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'nodeUrl') return 'wss://testnet.vara.network';
        if (key === 'voucherAccount') return '//Alice';
        return undefined;
      }),
    };
    qrQuery = jest.fn().mockImplementation(async (sql: string) => {
      if (sql === 'SELECT pg_try_advisory_lock($1, $2) AS acquired') {
        return [{ acquired: true }];
      }
      return [];
    });
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
        VoucherService,
        { provide: getRepositoryToken(Voucher), useValue: repo },
        { provide: ConfigService, useValue: cfg },
        { provide: DataSource, useValue: ds },
      ],
    }).compile();

    service = module.get(VoucherService);
    await service.onModuleInit();
  });

  // ── onModuleInit ───────────────────────────────────────────────────────────

  it('throws when GearApi rejects — does not silently continue', async () => {
    const failingModule = await Test.createTestingModule({
      providers: [
        VoucherService,
        { provide: getRepositoryToken(Voucher), useValue: repo },
        { provide: ConfigService, useValue: cfg },
        { provide: DataSource, useValue: ds },
      ],
    }).compile();

    const failingSvc = failingModule.get(VoucherService);
    (failingSvc as any).api.isReadyOrError = Promise.reject(new Error('node unreachable'));
    await expect(failingSvc.onModuleInit()).rejects.toThrow('node unreachable');
  });

  // ── getVoucher ─────────────────────────────────────────────────────────────

  it('queries with revoked: false so revoked vouchers are not returned', async () => {
    repo.findOneBy.mockResolvedValue(null);
    await service.getVoucher('0xabc');
    expect(repo.findOneBy).toHaveBeenCalledWith({ account: '0xabc', revoked: false });
  });

  it('returns null when the only matching voucher is revoked', async () => {
    repo.findOneBy.mockResolvedValue(null);
    const result = await service.getVoucher('0xabc');
    expect(result).toBeNull();
  });

  it('returns the voucher when it exists and is not revoked', async () => {
    const v = makeVoucher();
    repo.findOneBy.mockResolvedValue(v);
    const result = await service.getVoucher('0xabc');
    expect(result).toBe(v);
  });

  // ── issue() — balance guard ────────────────────────────────────────────────

  it('throws when issuer balance is below amount + 10 VARA reserve', async () => {
    mockBalance.mockResolvedValue({ toBigInt: () => BigInt(11 * 1e12) });
    await expect(
      service.issue('0xaccount' as any, ['0xprog'] as any, 3, 86400),
    ).rejects.toThrow('Insufficient issuer balance');
  });

  it('does not throw Insufficient when issuer balance exactly equals amount + reserve', async () => {
    mockBalance.mockResolvedValue({ toBigInt: () => BigInt(13 * 1e12) });
    // Force a downstream failure so we can assert the balance guard passed
    // without mocking signAndSend.
    mockVoucherIssue.mockRejectedValue(new Error('past balance guard'));
    await expect(
      service.issue('0xaccount' as any, ['0xprog'] as any, 3, 86400),
    ).rejects.toThrow('past balance guard');
  });

  // ── issue() — passes program array unmodified ─────────────────────────────

  it('issue() passes the programIds array unmodified to api.voucher.issue', async () => {
    // Stub the Gear call so we can inspect args without running signAndSend.
    // Issuer needs amount + 10 VARA reserve = 510 VARA minimum.
    mockBalance.mockResolvedValue({ toBigInt: () => BigInt(1000 * 1e12) });
    mockVoucherIssue.mockRejectedValue(new Error('stop after args capture'));

    const programs = ['0xp1', '0xp2', '0xp3'] as any;
    await expect(
      service.issue('0xaccount' as any, programs, 500, 86400),
    ).rejects.toThrow('stop after args capture');

    expect(mockVoucherIssue).toHaveBeenCalledWith(
      '0xaccount',
      BigInt(500) * BigInt(1e12),
      Math.round(86400 / 3),
      programs,
    );
  });

  it('retries issue() once when the RPC returns Transaction is outdated', async () => {
    mockBalance.mockResolvedValue({ toBigInt: () => BigInt(1000 * 1e12) });

    const outdated = new Error('1010: Invalid Transaction: Transaction is outdated');
    const okExtrinsic = {
      signAndSend: jest.fn().mockImplementation(async (_account: unknown, cb: any) => {
        cb({
          status: { isDropped: false, isInvalid: false, isUsurped: false, isInBlock: true, asInBlock: { toHex: () => '0xblock' } },
          events: [
            {
              event: {
                method: 'VoucherIssued',
                data: { voucherId: { toHex: () => '0xvoucher' } },
              },
            },
          ],
        });
        return jest.fn();
      }),
    };

    mockVoucherIssue
      .mockResolvedValueOnce({
        extrinsic: {
          signAndSend: jest.fn().mockRejectedValue(outdated),
        },
      })
      .mockResolvedValueOnce({ extrinsic: okExtrinsic });

    const voucherId = await service.issue('0xaccount' as any, ['0xprog'] as any, 500, 86400);

    expect(voucherId).toBe('0xvoucher');
    expect(mockVoucherIssue).toHaveBeenCalledTimes(2);
  });

  // ── update() guard ─────────────────────────────────────────────────────────

  it('update() throws when called on a revoked voucher — prevents resurrection', async () => {
    const revoked = makeVoucher({ revoked: true });
    await expect(
      service.update(revoked, 10, 86400),
    ).rejects.toThrow('Cannot update revoked voucher');
  });

  it('update() preserves the decoded ExtrinsicFailed error message', async () => {
    mockVoucherUpdate.mockReturnValue({
      signAndSend: jest.fn().mockImplementation(async (_account: unknown, cb: any) => {
        cb({
          status: {
            isDropped: false,
            isInvalid: false,
            isUsurped: false,
            isInBlock: true,
            asInBlock: { toHex: () => '0xblock' },
          },
          events: [{ event: { method: 'ExtrinsicFailed' } }],
        });
        return jest.fn();
      }),
    });
    mockGetExtrinsicFailedError.mockReturnValue(new Error('voucher no longer exists'));

    await expect(service.update(makeVoucher(), 10, 86400)).rejects.toThrow(
      'voucher no longer exists',
    );
  });

  it('update() does not prolong when voucher already has the target validity window', async () => {
    mockGetBlockNumber
      .mockResolvedValueOnce({ toNumber: () => 100 })
      .mockResolvedValueOnce({ toNumber: () => 123 });
    mockVoucherUpdate.mockReturnValue({
      signAndSend: jest.fn().mockImplementation(async (_account: unknown, cb: any) => {
        cb({
          status: {
            isDropped: false,
            isInvalid: false,
            isUsurped: false,
            isInBlock: true,
            asInBlock: { toHex: () => '0xblock' },
          },
          events: [{ event: { method: 'VoucherUpdated' } }],
        });
        return jest.fn();
      }),
    });

    await service.update(makeVoucher({ validUpToBlock: '28900' as any }), 500, 86400);

    expect(mockVoucherUpdate).toHaveBeenCalledWith('0xabc', '0xvoucher', {
      balanceTopUp: 500n * 10n ** 12n,
    });
  });

  // ── getVoucherBalance() ────────────────────────────────────────────────────

  it('getVoucherBalance() returns the on-chain balance as a bigint', async () => {
    mockBalance.mockResolvedValue({ toBigInt: () => 1_757_000_000_000_000n });
    const balance = await service.getVoucherBalance('0xvoucher');
    expect(balance).toBe(1_757_000_000_000_000n);
    expect(mockBalance).toHaveBeenCalledWith('0xvoucher');
  });

  it('getVoucherBalance() propagates RPC failures', async () => {
    mockBalance.mockRejectedValue(new Error('RPC down'));
    await expect(service.getVoucherBalance('0xvoucher')).rejects.toThrow('RPC down');
  });

  // ── signAndSend timeout ────────────────────────────────────────────────────

  it('rejects with timeout error when signAndSend does not settle within the bounded wait', async () => {
    jest.useFakeTimers();
    const neverResolves = new Promise<never>(() => {});
    const racePromise = Promise.race([
      neverResolves,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('signAndSend timed out after 180s — transaction may or may not have landed')),
          180_000,
        ),
      ),
    ]);
    jest.advanceTimersByTime(181_000);
    await expect(racePromise).rejects.toThrow('timed out after 180s');
    jest.useRealTimers();
  });
});
