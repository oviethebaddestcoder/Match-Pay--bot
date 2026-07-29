import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum WithdrawalStatus {
  PENDING = 'PENDING', // balance debited, disbursement call about to fire
  PROCESSING = 'PROCESSING', // disbursement accepted by Monnify, awaiting webhook
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED', // balance was refunded
}

@Entity('withdrawals')
export class Withdrawal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sellerId: string;

  @Column('decimal', { precision: 12, scale: 2 })
  amount: number;

  // Unique reference sent to Monnify - also used to match the disbursement webhook
  // back to this withdrawal, same pattern as accountReference for orders.
  @Column({ unique: true })
  reference: string;

  @Column({ nullable: true })
  monnifyTransactionReference: string;

  @Column({ type: 'simple-enum', enum: WithdrawalStatus, default: WithdrawalStatus.PENDING })
  status: WithdrawalStatus;

  @Column({ nullable: true })
  failureReason: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
