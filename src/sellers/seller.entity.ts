import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum SellerStatus {
  // Multi-step registration in progress - conversation state lives in WhatsappService,
  // this column is the source of truth for "is this seller allowed to transact yet".
  ONBOARDING = 'ONBOARDING',
  ACTIVE = 'ACTIVE',
  // Set after 3 consecutive wrong withdrawal PIN attempts. Requires manual review
  // to clear - deliberately NOT self-service, since self-service PIN reset is
  // exactly the kind of hole an attacker who's compromised the WhatsApp session wants.
  LOCKED = 'LOCKED',
}

export enum OnboardingStep {
  WELCOME = 'WELCOME',
  BUSINESS_NAME = 'BUSINESS_NAME',
  EMAIL = 'EMAIL',
  BANK_SELECT = 'BANK_SELECT',
  ACCOUNT_NUMBER = 'ACCOUNT_NUMBER',
  CONFIRM_ACCOUNT = 'CONFIRM_ACCOUNT',
  SET_PIN = 'SET_PIN',
  CONFIRM_PIN = 'CONFIRM_PIN',
  DONE = 'DONE',
}

@Entity('sellers')
export class Seller {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  whatsappNumber: string; // E.164 without '+', e.g. 2348012345678

  @Column({ type: 'simple-enum', enum: OnboardingStep, default: OnboardingStep.WELCOME })
  onboardingStep: OnboardingStep;

  // Held here mid-verification, only promoted to the real settlementXxx
  // fields once the seller confirms the name Monnify returned matches.
  @Column({ nullable: true })
  pendingBankCode: string;

  @Column({ nullable: true })
  pendingAccountNumber: string;

  @Column({ nullable: true })
  pendingAccountName: string;

  // Hash of the PIN entered on first attempt, held until re-entered and
  // confirmed to match - never promoted to pinHash until confirmed twice.
  @Column({ nullable: true })
  pendingPinHash: string;

  @Column({ nullable: true })
  businessName: string;

  @Column({ nullable: true })
  email: string;

  // Settlement account is captured once at onboarding and verified via Monnify's
  // name-enquiry endpoint before being trusted. Withdrawals ALWAYS go here -
  // there is no "enter a new account at withdrawal time" path, by design.
  @Column({ nullable: true })
  settlementBankCode: string;

  @Column({ nullable: true })
  settlementAccountNumber: string;

  @Column({ nullable: true })
  settlementAccountName: string; // as returned by Monnify's verification, not self-reported

  // bcrypt hash only - never store or log the raw PIN.
  @Column({ nullable: true })
  pinHash: string;

  @Column({ default: 0 })
  pinFailedAttempts: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  balance: number; // available wallet balance, net of platform fees, net of prior withdrawals

  @Column({ type: 'simple-enum', enum: SellerStatus, default: SellerStatus.ONBOARDING })
  status: SellerStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
