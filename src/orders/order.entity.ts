import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sellerId: string;

  @Column()
  buyerName: string;

  @Column({ nullable: true })
  buyerWhatsapp: string; // optional - lets the bot message the buyer directly on payment

  @Column('decimal', { precision: 12, scale: 2 })
  amount: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  platformFee: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  netAmount: number; // amount - platformFee; what the seller actually receives

  @Column({ default: 'NGN' })
  currency: string;

  // The unique reference we send to Monnify when initializing the transaction.
  // This is what lets us match a webhook back to exactly one order - Monnify
  // echoes it back as `paymentReference` in the payment webhook payload.
  @Column({ unique: true })
  paymentReference: string;

  @Column({ nullable: true })
  monnifyAccountNumber: string;

  @Column({ nullable: true })
  monnifyAccountName: string;

  @Column({ nullable: true })
  monnifyBankName: string;

  // Dynamic accounts are only valid for a limited window (max 40 minutes).
  // Used to warn the seller/buyer and to decide whether an order needs
  // its payment account renewed.
  @Column({ nullable: true })
  accountExpiresAt: Date;

  @Column({ type: 'simple-enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Column({ nullable: true })
  paidAt: Date;

  @Column({ nullable: true })
  monnifyTransactionReference: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
