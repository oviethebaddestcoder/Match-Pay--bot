/**
 * MatchPay platform fee model.
 *
 * 1% of the order amount, floored at ₦10 (so tiny transactions still
 * cover payment processing overhead) and capped at ₦500 (so large orders
 * aren't penalized disproportionately - keeps the fee feeling fair at scale).
 *
 * This is intentionally isolated in one file: tune FEE_PERCENT / FLOOR / CAP
 * here and it propagates everywhere (order creation, WhatsApp messages,
 * webhook confirmations) without touching business logic elsewhere.
 */

const FEE_PERCENT = 0.01; // 1%
const FEE_FLOOR = 10; // ₦10 minimum
const FEE_CAP = 500; // ₦500 maximum

export interface FeeBreakdown {
  grossAmount: number;
  platformFee: number;
  netAmount: number; // what the seller actually receives after MatchPay's cut
}

export function calculateFee(grossAmount: number): FeeBreakdown {
  const rawFee = grossAmount * FEE_PERCENT;
  const platformFee = Math.round(Math.min(Math.max(rawFee, FEE_FLOOR), FEE_CAP));
  const netAmount = Math.round((grossAmount - platformFee) * 100) / 100;

  return {
    grossAmount,
    platformFee,
    netAmount,
  };
}
