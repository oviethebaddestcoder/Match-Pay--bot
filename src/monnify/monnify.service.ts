import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

export interface DynamicAccountResult {
  accountNumber: string;
  accountName: string;
  bankName: string;
  monnifyTransactionReference: string;
  expiresInSeconds: number;
}

export interface BankOption {
  name: string;
  code: string;
}

@Injectable()
export class MonnifyService {
  private readonly logger = new Logger(MonnifyService.name);

  // Cache the bearer token in memory; Monnify tokens are typically valid ~1hr.
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  // Full bank list rarely changes - cache it for a few hours rather than
  // hitting Monnify's API on every "which bank" step of onboarding.
  private bankListCache: BankOption[] | null = null;
  private bankListCachedAt = 0;
  private readonly BANK_LIST_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get baseUrl(): string {
    return this.config.get<string>('MONNIFY_BASE_URL')!;
  }

  /**
   * Authenticates with Monnify using API key + secret key (Basic Auth)
   * and caches the bearer token until it's close to expiry.
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const apiKey = this.config.get<string>('MONNIFY_API_KEY');
    const secretKey = this.config.get<string>('MONNIFY_SECRET_KEY');
    const basicAuth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

    try {
      const { data } = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/api/v1/auth/login`,
          {},
          { headers: { Authorization: `Basic ${basicAuth}` } },
        ),
      );

      const token = data?.responseBody?.accessToken;
      const expiresIn = data?.responseBody?.expiresIn ?? 3600; // seconds
      if (!token) {
        throw new Error('Monnify auth response missing accessToken');
      }

      this.accessToken = token;
      // Refresh a bit early (60s buffer) to avoid using an about-to-expire token.
      this.tokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;
      return token;
    } catch (err) {
      this.logger.error('Monnify authentication failed', err as Error);
      throw new InternalServerErrorException('Failed to authenticate with Monnify');
    }
  }

  /**
   * Fetches Monnify's full list of supported banks - including mobile money
   * wallets like OPay, PalmPay, Moniepoint, Kuda, wherever Monnify itself
   * supports them - rather than a hardcoded list. This matters because bank
   * "codes" are NOT standardized across providers: different payment
   * processors use different code conventions for the same institution, so
   * a code copied from a different provider's docs can silently point
   * withdrawals at the wrong destination. Only Monnify's own list is
   * guaranteed to work with Monnify's own transfer/verification APIs.
   */
  async getAllBanks(): Promise<BankOption[]> {
    const isFresh = this.bankListCache && Date.now() - this.bankListCachedAt < this.BANK_LIST_TTL_MS;
    if (isFresh) return this.bankListCache!;

    const token = await this.getAccessToken();
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/api/v1/banks`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      const banks: BankOption[] = (data?.responseBody ?? []).map((b: any) => ({
        name: b.name,
        code: b.code,
      }));
      this.bankListCache = banks;
      this.bankListCachedAt = Date.now();
      return banks;
    } catch (err) {
      this.logger.error('Failed to fetch Monnify bank list', err as Error);
      // Serve a stale cache over a hard failure if we have one at all -
      // better to let onboarding continue with slightly old data than to
      // block every seller because of one transient API hiccup.
      if (this.bankListCache) return this.bankListCache;
      throw new InternalServerErrorException('Could not load the list of supported banks');
    }
  }

  /**
   * Case-insensitive substring search over the live bank list, so a seller
   * can type "opay" or "gtbank" or "kuda" and get matches - no need to
   * scroll a fixed menu, and no risk of a bank simply being missing from
   * a hand-maintained list.
   */
  async searchBanks(query: string): Promise<BankOption[]> {
    const banks = await this.getAllBanks();
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return banks.filter((b) => b.name.toLowerCase().includes(needle));
  }

  /**
   * Creates a one-time dynamic virtual account for a single order.
   *
   * This is Monnify's "dynamic account" / one-time-payment flow, NOT the
   * Reserved Account API. That distinction matters at scale: a Reserved
   * Account is a persistent object meant for a recurring billing
   * relationship (and Monnify's docs tie static/persistent reservations to
   * KYC data like BVN/NIN). Creating one of those per ORDER would mean
   * thousands of permanent, mostly-dormant account objects piling up.
   *
   * The dynamic flow instead ties a fresh, temporary account number
   * directly to a single transaction - it expires on its own (max 40
   * minutes) and needs no KYC step, which is exactly the shape of a
   * one-time buyer payment.
   *
   * Two calls are required: first initialize the transaction (this is
   * where our own unique paymentReference is registered with Monnify),
   * then request the actual bank-transfer account details for it.
   */
  async createDynamicAccountForOrder(params: {
    paymentReference: string;
    amount: number;
    customerEmail: string;
    customerName: string;
  }): Promise<DynamicAccountResult> {
    const token = await this.getAccessToken();
    const contractCode = this.config.get<string>('MONNIFY_CONTRACT_CODE');
    const redirectUrl =
      this.config.get<string>('MONNIFY_REDIRECT_URL') || 'https://matchpay.example.com/thank-you';

    let transactionReference: string;
    try {
      const { data } = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/api/v1/merchant/transactions/init-transaction`,
          {
            amount: params.amount,
            customerName: params.customerName,
            customerEmail: params.customerEmail,
            paymentReference: params.paymentReference,
            paymentDescription: `MatchPay order for ${params.customerName}`,
            currencyCode: 'NGN',
            contractCode,
            redirectUrl,
            paymentMethods: ['ACCOUNT_TRANSFER'],
          },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      transactionReference = data?.responseBody?.transactionReference;
      if (!transactionReference) {
        throw new Error('Monnify init-transaction response missing transactionReference');
      }
    } catch (err) {
      this.logger.error('Monnify transaction initialization failed', err as Error);
      throw new InternalServerErrorException('Failed to initialize payment with Monnify');
    }

    try {
      const { data } = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/api/v1/merchant/bank-transfer/init-payment`,
          { transactionReference },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );

      const body = data?.responseBody;
      if (!body?.accountNumber) {
        throw new Error('Monnify bank-transfer response missing accountNumber');
      }

      return {
        accountNumber: body.accountNumber,
        accountName: body.accountName,
        bankName: body.bankName,
        monnifyTransactionReference: transactionReference,
        // Monnify returns the remaining validity window in seconds (max 2400 / 40 min).
        expiresInSeconds: Number(body.accountDuration ?? 2400),
      };
    } catch (err) {
      this.logger.error('Monnify bank-transfer account creation failed', err as Error);
      throw new InternalServerErrorException(
        'Failed to generate a payment account for this order',
      );
    }
  }

  /**
   * Verifies that an incoming webhook actually came from Monnify by
   * recomputing the HMAC SHA512 signature over the raw request body
   * using the secret key, and comparing it to the signature header.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;
    const secretKey = this.config.get<string>('MONNIFY_SECRET_KEY')!;
    const computedHash = crypto
      .createHmac('sha512', secretKey)
      .update(rawBody)
      .digest('hex');

    // Plain `===` on secrets/signatures leaks timing information an attacker
    // can use to guess the correct value byte-by-byte. timingSafeEqual takes
    // constant time regardless of where the first mismatch occurs - but it
    // requires equal-length buffers, so mismatched lengths are rejected
    // up front rather than passed in (which would throw).
    const computedBuffer = Buffer.from(computedHash, 'hex');
    const providedBuffer = Buffer.from(signatureHeader, 'hex');
    if (computedBuffer.length !== providedBuffer.length) return false;

    return crypto.timingSafeEqual(computedBuffer, providedBuffer);
  }

  /**
   * Verifies a bank account exists and returns the account holder's name
   * as held by the bank. Used at seller onboarding so we NEVER trust a
   * self-reported account name - the seller must confirm the name Monnify
   * returns, which makes it much harder to register a mistyped or
   * someone-else's account by accident.
   */
  async validateBankAccount(params: {
    accountNumber: string;
    bankCode: string;
  }): Promise<{ accountName: string }> {
    const token = await this.getAccessToken();
    try {
      const { data } = await firstValueFrom(
        this.http.get(
          `${this.baseUrl}/api/v1/disbursements/account/validate`,
          {
            params: {
              accountNumber: params.accountNumber,
              bankCode: params.bankCode,
            },
            headers: { Authorization: `Bearer ${token}` },
          },
        ),
      );
      const accountName = data?.responseBody?.accountName;
      if (!accountName) throw new Error('Verification response missing accountName');
      return { accountName };
    } catch (err) {
      this.logger.error('Monnify account validation failed', err as Error);
      throw new InternalServerErrorException(
        'Could not verify that bank account. Double-check the number and bank.',
      );
    }
  }

  /**
   * Initiates a single disbursement (payout) to a previously-verified
   * settlement account. `reference` must be unique per attempt - it's how
   * we match the async disbursement webhook back to our Withdrawal record,
   * and it also gives Monnify natural idempotency if we ever retry.
   */
  async initiateTransfer(params: {
    reference: string;
    amount: number;
    narration: string;
    bankCode: string;
    accountNumber: string;
  }): Promise<{ status: string; monnifyReference: string }> {
    const token = await this.getAccessToken();
    const sourceAccountNumber = this.config.get<string>('MONNIFY_SOURCE_ACCOUNT_NUMBER');

    try {
      const { data } = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/api/v2/disbursements/single`,
          {
            amount: params.amount,
            reference: params.reference,
            narration: params.narration,
            destinationBankCode: params.bankCode,
            destinationAccountNumber: params.accountNumber,
            currency: 'NGN',
            sourceAccountNumber,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );

      const body = data?.responseBody;
      return {
        status: body?.status ?? 'PENDING',
        monnifyReference: body?.reference ?? params.reference,
      };
    } catch (err) {
      this.logger.error('Monnify disbursement failed', err as Error);
      throw new InternalServerErrorException('Payout to your bank account failed to initiate');
    }
  }

}
