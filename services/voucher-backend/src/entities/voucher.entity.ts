import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('voucher')
export class Voucher {
  constructor(props?: Partial<Voucher>) {
    if (props) Object.assign(this, props);
  }

  @PrimaryGeneratedColumn('uuid')
  id?: string;

  @Column({ name: 'voucher_id', nullable: false, unique: true })
  voucherId: string;

  @Column({ nullable: false })
  account: string;

  @Column({ type: 'jsonb' })
  programs: string[];

  @Column({ name: 'vara_to_issue', type: 'float', nullable: false, default: 0 })
  varaToIssue: number;

  @Column({
    name: 'created_at',
    type: 'timestamp without time zone',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt?: Date;

  @Column({ type: 'bigint', name: 'valid_up_to_block', nullable: false })
  validUpToBlock: bigint;

  @Column({
    name: 'valid_up_to',
    type: 'timestamp without time zone',
    nullable: false,
  })
  validUpTo: Date;

  @Column({ name: 'revoked', type: 'boolean', default: false })
  revoked: boolean;

  // Funding marker: advances on VoucherService.issue() and VoucherService.update()
  // when the voucher gets a balance top-up. It does not advance when programs
  // are appended free of charge inside the current tranche interval.
  @Column({
    name: 'last_renewed_at',
    type: 'timestamp without time zone',
    default: () => 'CURRENT_TIMESTAMP',
  })
  lastRenewedAt: Date;
}
