import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Withdrawal, WithdrawalStatus } from './withdrawal.entity';
import { Seller } from '../sellers/seller.entity';
import { SellersService } from '../sellers/sellers.service';
import { MonnifyService } from '../monnify/monnify.service';

const MIN_WITHDRAWAL = 100; // ₦100 - Monnify disbursement minimums vary, adjust to your account
const MAX_WITHDRAWAL_PER_REQUEST = 1_000_000; // ₦1,000,000 - basic guardrail against fat-finger amounts

@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    @InjectRepository(Withdrawal) private readonly withdrawalsRepo: Repository<Withdrawal>,
    private readonly sellers: SellersService,
    private readonly monnify: MonnifyService,
  ) {}

  /**
   * The full withdrawal flow, run only AFTER the caller (WhatsappService)
   * has already verified the seller's PIN. Order of operations matters here:
   * 1. Debit the wallet first, via an atomic conditional UPDATE (SellersService).
   * 2. Only then call out to Monnify.
   * 3. If the Monnify call fails, refund immediately.
   * This means a seller's visible balance is always the ground truth of what
   * they can still withdraw - it can't be double-spent by a second request
   * racing in before Monnify responds to the first.
   */
  async requestWithdrawal(seller: Seller, amount: number): Promise<Withdrawal> {
    if (amount < MIN_WITHDRAWAL) {
      throw new Error(`Minimum withdrawal is ₦${MIN_WITHDRAWAL.toLocaleString()}`);
    }
    if (amount > MAX_WITHDRAWAL_PER_REQUEST) {
      throw new Error(
        `Maximum withdrawal per request is ₦${MAX_WITHDRAWAL_PER_REQUEST.toLocaleString()}`,
      );
    }
    if (!seller.settlementAccountNumber || !seller.settlementBankCode) {
      throw new Error('No verified settlement account on file for this seller');
    }

    // Step 1: lock and debit the wallet before touching Monnify.
    await this.sellers.debitBalanceForWithdrawal(seller.id, amount);

    const reference = `matchpay-wd-${uuidv4()}`;
    const withdrawal = await this.withdrawalsRepo.save(
      this.withdrawalsRepo.create({
        sellerId: seller.id,
        amount,
        reference,
        status: WithdrawalStatus.PENDING,
      }),
    );

    // Step 2: attempt the actual payout. Any failure here gets refunded
    // immediately so the seller's balance never silently vanishes.
    try {
      const result = await this.monnify.initiateTransfer({
        reference,
        amount,
        narration: `MatchPay withdrawal for ${seller.businessName ?? seller.whatsappNumber}`,
        bankCode: seller.settlementBankCode,
        accountNumber: seller.settlementAccountNumber,
      });

      withdrawal.status = WithdrawalStatus.PROCESSING;
      withdrawal.monnifyTransactionReference = result.monnifyReference;
      return this.withdrawalsRepo.save(withdrawal);
    } catch (err) {
      this.logger.error(
        `Disbursement call failed for withdrawal ${withdrawal.id}, refunding seller ${seller.id}`,
        err as Error,
      );
      await this.sellers.refundBalance(seller.id, amount);
      withdrawal.status = WithdrawalStatus.FAILED;
      withdrawal.failureReason = 'Failed to initiate disbursement';
      return this.withdrawalsRepo.save(withdrawal);
    }
  }

  async findByReference(reference: string): Promise<Withdrawal | null> {
    return this.withdrawalsRepo.findOne({ where: { reference } });
  }

  /**
   * Called from the disbursement webhook once Monnify confirms final status.
   * On failure, refunds the seller - this is the second (and final) place
   * money can come back to the wallet if a payout doesn't complete.
   */
  /**
   * Called from the disbursement webhook once Monnify confirms final status.
   * On failure, refunds the seller - this is the second (and final) place
   * money can come back to the wallet if a payout doesn't complete.
   *
   * Uses the same atomic-conditional-update pattern as Orders.markPaid, for
   * the same reason: two disbursement webhook deliveries racing each other
   * must not both refund the same failed withdrawal (that would credit the
   * seller twice for one failure).
   */
  async markCompleted(
    reference: string,
    success: boolean,
    failureReason?: string,
  ): Promise<{ withdrawal: Withdrawal; newlyFinalized: boolean }> {
    const existing = await this.findByReference(reference);
    if (!existing) {
      throw new NotFoundException(`No withdrawal found for reference ${reference}`);
    }

    const result = await this.withdrawalsRepo
      .createQueryBuilder()
      .update(Withdrawal)
      .set({
        status: success ? WithdrawalStatus.SUCCESS : WithdrawalStatus.FAILED,
        failureReason: success ? undefined : failureReason ?? 'Disbursement failed',
      })
      .where('id = :id AND status != :success AND status != :failed')
      .setParameters({
        id: existing.id,
        success: WithdrawalStatus.SUCCESS,
        failed: WithdrawalStatus.FAILED,
      })
      .execute();

    const newlyFinalized = (result.affected ?? 0) > 0;

    if (newlyFinalized && !success) {
      await this.sellers.refundBalance(existing.sellerId, Number(existing.amount));
    }

    const finalWithdrawal = await this.withdrawalsRepo.findOneOrFail({ where: { id: existing.id } });
    return { withdrawal: finalWithdrawal, newlyFinalized };
  }
}
