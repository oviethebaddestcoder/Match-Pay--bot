import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { OnboardingStep, Seller, SellerStatus } from './seller.entity';

const MAX_PIN_ATTEMPTS = 3;
const PIN_SALT_ROUNDS = 12;

@Injectable()
export class SellersService {
  private readonly logger = new Logger(SellersService.name);

  constructor(
    @InjectRepository(Seller) private readonly sellersRepo: Repository<Seller>,
  ) {}

  async findByWhatsapp(whatsappNumber: string): Promise<Seller | null> {
    return this.sellersRepo.findOne({ where: { whatsappNumber } });
  }

  async findById(id: string): Promise<Seller> {
    return this.sellersRepo.findOneOrFail({ where: { id } });
  }

  async findOrCreateDraft(whatsappNumber: string): Promise<Seller> {
    let seller = await this.findByWhatsapp(whatsappNumber);
    if (!seller) {
      seller = this.sellersRepo.create({
        whatsappNumber,
        status: SellerStatus.ONBOARDING,
      });
      seller = await this.sellersRepo.save(seller);
    }
    return seller;
  }

  async update(id: string, patch: Partial<Seller>): Promise<Seller> {
    await this.sellersRepo.update(id, patch);
    return this.sellersRepo.findOneOrFail({ where: { id } });
  }

  async setStep(id: string, step: OnboardingStep): Promise<void> {
    await this.sellersRepo.update(id, { onboardingStep: step });
  }

  async setBusinessName(id: string, businessName: string): Promise<void> {
    await this.sellersRepo.update(id, {
      businessName,
      onboardingStep: OnboardingStep.EMAIL,
    });
  }

  async setEmail(id: string, email: string): Promise<void> {
    await this.sellersRepo.update(id, {
      email,
      onboardingStep: OnboardingStep.BANK_SELECT,
    });
  }

  /**
   * Stores an UNVERIFIED settlement account pending confirmation - not yet
   * trusted as the payout destination. Call confirmSettlementAccount()
   * only after the seller has seen and accepted the name Monnify returned.
   */
  async setPendingSettlement(
    id: string,
    params: { bankCode: string; accountNumber: string; accountName: string },
  ): Promise<void> {
    await this.sellersRepo.update(id, {
      pendingBankCode: params.bankCode,
      pendingAccountNumber: params.accountNumber,
      pendingAccountName: params.accountName,
      onboardingStep: OnboardingStep.CONFIRM_ACCOUNT,
    });
  }

  /**
   * Promotes the pending (Monnify-verified) settlement account to the
   * live settlement fields. This is the only path by which settlementXxx
   * fields are ever set - there's no direct "update settlement account"
   * shortcut elsewhere in the codebase, on purpose.
   */
  async confirmSettlementAccount(id: string): Promise<Seller> {
    const seller = await this.sellersRepo.findOneOrFail({ where: { id } });
    await this.sellersRepo.update(id, {
      settlementBankCode: seller.pendingBankCode,
      settlementAccountNumber: seller.pendingAccountNumber,
      settlementAccountName: seller.pendingAccountName,
      pendingBankCode: null,
      pendingAccountNumber: null,
      pendingAccountName: null,
      onboardingStep: OnboardingStep.SET_PIN,
    });
    return this.sellersRepo.findOneOrFail({ where: { id } });
  }

  async rejectPendingSettlement(id: string): Promise<void> {
    await this.sellersRepo.update(id, {
      pendingBankCode: null,
      pendingAccountNumber: null,
      pendingAccountName: null,
      onboardingStep: OnboardingStep.BANK_SELECT,
    });
  }

  /** First PIN entry - held pending, not yet active. */
  async setPendingPin(id: string, rawPin: string): Promise<void> {
    const pendingPinHash = await bcrypt.hash(rawPin, PIN_SALT_ROUNDS);
    await this.sellersRepo.update(id, {
      pendingPinHash,
      onboardingStep: OnboardingStep.CONFIRM_PIN,
    });
  }

  /**
   * Confirms the second PIN entry matches the first before activating it.
   * Requiring double entry (rather than trusting a single typed PIN)
   * catches typos that would otherwise lock a seller out of their own
   * withdrawal on the very first attempt.
   */
  async confirmPendingPin(id: string, rawPin: string): Promise<boolean> {
    const seller = await this.sellersRepo.findOneOrFail({ where: { id } });
    if (!seller.pendingPinHash) return false;

    const matches = await bcrypt.compare(rawPin, seller.pendingPinHash);
    if (!matches) return false;

    await this.sellersRepo.update(id, {
      pinHash: seller.pendingPinHash,
      pendingPinHash: null,
      pinFailedAttempts: 0,
      status: SellerStatus.ACTIVE,
      onboardingStep: OnboardingStep.DONE,
    });
    return true;
  }

  /**
   * Verifies a withdrawal PIN. Applies lockout after MAX_PIN_ATTEMPTS
   * consecutive failures - locking is intentionally sticky (requires
   * manual admin clearance) rather than a timed cooldown, since this
   * guards money movement, not just a login.
   */
  async verifyPin(id: string, rawPin: string): Promise<boolean> {
    const seller = await this.sellersRepo.findOneOrFail({ where: { id } });

    if (seller.status === SellerStatus.LOCKED) {
      throw new UnauthorizedException(
        'This account is locked after repeated failed PIN attempts. Contact support.',
      );
    }

    const isValid = seller.pinHash
      ? await bcrypt.compare(rawPin, seller.pinHash)
      : false;

    if (isValid) {
      if (seller.pinFailedAttempts > 0) {
        await this.sellersRepo.update(id, { pinFailedAttempts: 0 });
      }
      return true;
    }

    const attempts = seller.pinFailedAttempts + 1;
    const shouldLock = attempts >= MAX_PIN_ATTEMPTS;
    await this.sellersRepo.update(id, {
      pinFailedAttempts: attempts,
      status: shouldLock ? SellerStatus.LOCKED : seller.status,
    });

    if (shouldLock) {
      this.logger.warn(`Seller ${id} locked after ${attempts} failed PIN attempts`);
    }
    return false;
  }

  /**
   * Credits a seller's wallet on a confirmed payment.
   *
   * Uses a single atomic `UPDATE ... SET balance = balance + :amount`
   * rather than a read-then-write pattern. This is safe against concurrent
   * webhook deliveries (Monnify can retry) WITHOUT needing row-level locks
   * - which matters because SQLite doesn't support `SELECT ... FOR UPDATE`
   * the way Postgres does. The increment happens entirely inside one SQL
   * statement, so there's no window where two concurrent calls could both
   * read the same starting balance.
   */
  async creditBalance(sellerId: string, amount: number): Promise<void> {
    const result = await this.sellersRepo
      .createQueryBuilder()
      .update(Seller)
      .set({ balance: () => 'balance + :amount' })
      .where('id = :id')
      .setParameters({ amount, id: sellerId })
      .execute();

    if (!result.affected) {
      throw new NotFoundException(`Seller ${sellerId} not found while crediting balance`);
    }
  }

  /**
   * Debits a seller's wallet for a withdrawal.
   *
   * Same atomic-UPDATE pattern as creditBalance, with the sufficient-funds
   * check folded directly into the WHERE clause (`balance >= :amount`).
   * If two withdrawal requests race each other, only one UPDATE can match
   * the row at a time - the second will simply affect 0 rows once the
   * first has already reduced the balance below the requested amount,
   * and gets a clean "insufficient balance" error instead of overdrawing.
   */
  async debitBalanceForWithdrawal(sellerId: string, amount: number): Promise<void> {
    const result = await this.sellersRepo
      .createQueryBuilder()
      .update(Seller)
      .set({ balance: () => 'balance - :amount' })
      .where('id = :id AND balance >= :amount')
      .setParameters({ amount, id: sellerId })
      .execute();

    if (!result.affected) {
      const seller = await this.sellersRepo.findOne({ where: { id: sellerId } });
      if (!seller) {
        throw new NotFoundException(`Seller ${sellerId} not found`);
      }
      throw new UnauthorizedException('Insufficient balance');
    }
  }

  /**
   * Refunds a debited amount if a withdrawal fails after the balance was
   * already deducted (e.g. Monnify disbursement call errors out).
   */
  async refundBalance(sellerId: string, amount: number): Promise<void> {
    await this.creditBalance(sellerId, amount);
  }
}
