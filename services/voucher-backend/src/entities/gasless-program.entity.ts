import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum GaslessProgramStatus {
  Enabled = 'enabled',
  Disabled = 'disabled',
}

@Entity({ name: 'gasless_program' })
export class GaslessProgram {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: true })
  name!: string;

  @Column({ nullable: true, unique: true })
  address!: string;

  @Column({ nullable: false, name: 'vara_to_issue' })
  varaToIssue!: number;

  /** Relative gas weight for proportional cap allocation (e.g. 1 = light, 10 = heavy). */
  @Column({ nullable: false, default: 1 })
  weight!: number;

  @Column({ nullable: false })
  duration!: number;

  @Column({ type: 'enum', enum: GaslessProgramStatus, default: GaslessProgramStatus.Enabled })
  status!: GaslessProgramStatus;

  @Column({ nullable: true, default: false, name: 'one_time' })
  oneTime!: boolean;

  @Column({
    name: 'created_at',
    type: 'timestamp without time zone',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt!: Date;
}
