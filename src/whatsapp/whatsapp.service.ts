import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcodeTerminal from 'qrcode-terminal';
import { OrdersService } from '../orders/orders.service';
import { Order, OrderStatus } from '../orders/order.entity';
import { SellersService } from '../sellers/sellers.service';
import { OnboardingStep, Seller, SellerStatus } from '../sellers/seller.entity';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { MonnifyService, BankOption } from '../monnify/monnify.service';

// Transient, in-memory only - both deliberately NOT persisted:
// - pendingWithdrawals: an amount awaiting PIN confirmation
// - pendingBankSelection: a bank code chosen during onboarding, awaiting the
//   account number that goes with it
// If the server restarts mid-flow, the seller just re-sends the command;
// no half-finished money-movement or verification state survives a crash.
interface PendingWithdrawal {
  amount: number;
}

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: ReturnType<typeof makeWASocket>;
  private pendingWithdrawals = new Map<string, PendingWithdrawal>();
  private pendingBankSelection = new Map<string, string>(); // jid -> chosen bankCode
  private pendingBankSearch = new Map<string, BankOption[]>(); // jid -> numbered search results awaiting a pick
  private reconnectAttempts = 0;

  constructor(
    private readonly ordersService: OrdersService,
    private readonly sellersService: SellersService,
    private readonly withdrawalsService: WithdrawalsService,
    private readonly monnify: MonnifyService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    const { state, saveCreds } = await useMultiFileAuthState('./whatsapp-auth');

    // Baileys ships with a version number baked in at release time. WhatsApp
    // moves its web protocol version forward independently, and connecting
    // with a stale one gets silently rejected right after the handshake -
    // which looks exactly like: "connected to WA" -> "not logged in,
    // attempting registration" -> "Connection Failure", looping forever
    // with NO QR code ever printed. Fetching the current version at
    // connect time avoids depending on whatever was current when this
    // Baileys release shipped.
    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.logger.log(`Using WhatsApp Web version ${version.join('.')} (latest: ${isLatest})`);

    this.sock = makeWASocket({
      auth: state,
      version,
      // MatchPay only reacts to new incoming commands - it has no use for
      // old chat history or media. Syncing that (the default behavior)
      // is exactly what was producing the "Timed Out" / statusCode 408
      // warning in the logs right after a fresh pairing - a slow
      // best-effort background sync of your entire chat history that
      // this bot never reads. Turning it off removes that noise/risk
      // without affecting the bot's actual job.
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.logger.log('Scan this QR code with WhatsApp (expires in ~20-60s):');
        qrcodeTerminal.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        // 515 ("restart required") fires by design immediately after a
        // FIRST successful pairing - Baileys deliberately reconnects once
        // to finish registration. Without calling this out explicitly, it
        // looks identical to a generic failure right at the moment you're
        // trying to tell "it worked" from "it didn't." Reconnect fast here
        // (skip the backoff) since this one is expected, not a symptom of
        // a persistent problem.
        if (statusCode === DisconnectReason.restartRequired) {
          this.logger.log('Pairing successful - finishing setup, reconnecting automatically...');
          this.connect();
          return;
        }

        this.logger.warn(
          `WhatsApp connection closed (status ${statusCode ?? 'unknown'}). Reconnecting: ${shouldReconnect}`,
        );

        if (shouldReconnect) {
          // Exponential backoff (capped at 30s) instead of retrying
          // immediately - a persistent failure (bad version, network block,
          // rate limiting) shouldn't hammer WhatsApp's servers every few
          // seconds forever.
          this.reconnectAttempts += 1;
          const delayMs = Math.min(30_000, 2_000 * 2 ** (this.reconnectAttempts - 1));
          this.logger.warn(`Retrying connection in ${Math.round(delayMs / 1000)}s...`);
          setTimeout(() => this.connect(), delayMs);
        } else {
          this.logger.error(
            'Logged out of WhatsApp. Delete ./whatsapp-auth and restart to re-pair with a fresh QR code.',
          );
        }
      } else if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.logger.log('WhatsApp bot connected.');
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const text =
          msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? '';
        const from = msg.key.remoteJid;
        if (from && text) {
          await this.route(from, text.trim());
        }
      }
    });
  }

  private numberFromJid(jid: string): string {
    return jid.split('@')[0];
  }

  private async route(from: string, text: string) {
    const whatsappNumber = this.numberFromJid(from);
    const seller = await this.sellersService.findOrCreateDraft(whatsappNumber);

    if (seller.status === SellerStatus.LOCKED) {
      await this.send(
        from,
        '🔒 This account is locked after repeated failed PIN attempts. Contact support to unlock it.',
      );
      return;
    }

    if (this.pendingWithdrawals.has(from)) {
      await this.handleWithdrawalPinEntry(from, seller, text);
      return;
    }

    if (seller.status === SellerStatus.ONBOARDING) {
      await this.handleOnboarding(from, seller, text);
      return;
    }

    await this.handleActiveCommand(from, seller, text);
  }

  // ---------- Onboarding ----------

  private async handleOnboarding(from: string, seller: Seller, text: string) {
    switch (seller.onboardingStep) {
      case OnboardingStep.WELCOME: {
        await this.sellersService.setStep(seller.id, OnboardingStep.BUSINESS_NAME);
        await this.send(
          from,
          [
            '👋 Welcome to *MatchPay* - order reconciliation for chat sellers.',
            '',
            "Let's get your account set up. First, what's your business name?",
          ].join('\n'),
        );
        return;
      }

      case OnboardingStep.BUSINESS_NAME: {
        if (text.length < 2) {
          await this.send(from, 'Please send a valid business name.');
          return;
        }
        await this.sellersService.setBusinessName(seller.id, text);
        await this.send(from, "Great. What's your email address? (used for your Monnify records)");
        return;
      }

      case OnboardingStep.EMAIL: {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
          await this.send(from, "That doesn't look like a valid email. Please try again.");
          return;
        }
        await this.sellersService.setEmail(seller.id, text);
        await this.send(
          from,
          "Now let's set up where your withdrawals go. Type your bank's name - any Nigerian bank or wallet works, including OPay, PalmPay, Kuda, Moniepoint, and the rest.",
        );
        return;
      }

      case OnboardingStep.BANK_SELECT: {
        const pendingResults = this.pendingBankSearch.get(from);

        if (pendingResults) {
          const index = Number(text.trim());
          const picked = Number.isInteger(index) ? pendingResults[index - 1] : undefined;
          if (!picked) {
            await this.send(
              from,
              'Please reply with just the number next to your bank, or type a different name to search again.',
            );
            return;
          }
          this.pendingBankSearch.delete(from);
          this.pendingBankSelection.set(from, picked.code);
          await this.sellersService.setStep(seller.id, OnboardingStep.ACCOUNT_NUMBER);
          await this.send(from, `Got it - ${picked.name}. Now send your 10-digit account number.`);
          return;
        }

        await this.searchAndPromptBank(from, text);
        return;
      }

      case OnboardingStep.ACCOUNT_NUMBER: {
        await this.handleAccountNumberEntry(from, seller, text);
        return;
      }

      case OnboardingStep.CONFIRM_ACCOUNT: {
        if (/^y(es)?$/i.test(text)) {
          await this.sellersService.confirmSettlementAccount(seller.id);
          await this.send(
            from,
            "Account confirmed ✅. Last step: set a 4-digit withdrawal PIN. You'll need this every time you withdraw, so don't share it.",
          );
        } else if (/^n(o)?$/i.test(text)) {
          await this.sellersService.rejectPendingSettlement(seller.id);
          await this.send(from, "No problem, let's redo this. Type your bank's name to search again.");
        } else {
          await this.send(from, 'Please reply "yes" to confirm or "no" to re-enter your account details.');
        }
        return;
      }

      case OnboardingStep.SET_PIN: {
        if (!/^\d{4}$/.test(text)) {
          await this.send(from, 'PIN must be exactly 4 digits. Try again.');
          return;
        }
        await this.sellersService.setPendingPin(seller.id, text);
        await this.send(from, 'Please re-enter your 4-digit PIN to confirm it.');
        return;
      }

      case OnboardingStep.CONFIRM_PIN: {
        if (!/^\d{4}$/.test(text)) {
          await this.send(from, 'PIN must be exactly 4 digits. Try again.');
          return;
        }
        const matched = await this.sellersService.confirmPendingPin(seller.id, text);
        if (!matched) {
          await this.send(
            from,
            "That doesn't match your first entry. Let's restart the PIN step - send a new 4-digit PIN.",
          );
          await this.sellersService.setStep(seller.id, OnboardingStep.SET_PIN);
          return;
        }
        await this.send(
          from,
          [
            "🎉 You're all set up!",
            '',
            'Commands you can use:',
            '• new order <buyer name> | <amount> | [buyer WhatsApp number]',
            '• orders - list pending orders',
            '• renew <order id> - get a fresh payment account if one expired',
            '• balance - check your withdrawable balance',
            '• withdraw <amount> - cash out to your registered bank account',
            '• help - show this again',
          ].join('\n'),
        );
        return;
      }

      default:
        return;
    }
  }

  /**
   * Searches Monnify's live bank list by name and either asks the seller
   * to pick from numbered matches, or reports no match / a search failure.
   * Results are stashed in-memory so the seller's next message (a number)
   * can be resolved back to a bank code.
   */
  private async searchAndPromptBank(from: string, query: string) {
    let matches: BankOption[];
    try {
      matches = await this.monnify.searchBanks(query);
    } catch (err) {
      this.logger.error('Bank search failed', err as Error);
      await this.send(from, "⚠️ Couldn't load the bank list right now. Please try again in a moment.");
      return;
    }

    if (matches.length === 0) {
      await this.send(
        from,
        `No bank found matching "${query}". Try just part of the name, e.g. "opay", "gtbank", or "kuda".`,
      );
      return;
    }

    const top = matches.slice(0, 8);
    this.pendingBankSearch.set(from, top);
    const lines = top.map((b, i) => `${i + 1}. ${b.name}`);
    const countLabel =
      matches.length > top.length ? `Found ${matches.length} matches, showing top ${top.length}:` : `Found:`;

    await this.send(
      from,
      [countLabel, ...lines, '', 'Reply with the number. Or type a different name to search again.'].join('\n'),
    );
  }

  private async handleAccountNumberEntry(from: string, seller: Seller, text: string) {
    const accountNumber = text.replace(/\D/g, '');
    if (accountNumber.length < 10) {
      await this.send(from, 'Please send a valid account number (at least 10 digits).');
      return;
    }

    const bankCode = this.pendingBankSelection.get(from);
    if (!bankCode) {
      await this.sellersService.setStep(seller.id, OnboardingStep.BANK_SELECT);
      await this.send(from, "Let's pick your bank again - type its name to search.");
      return;
    }

    try {
      const { accountName } = await this.monnify.validateBankAccount({
        accountNumber,
        bankCode,
      });
      this.pendingBankSelection.delete(from);
      await this.sellersService.setPendingSettlement(seller.id, {
        bankCode,
        accountNumber,
        accountName,
      });
      await this.send(
        from,
        `We found: *${accountName}*\n\nIs this you? Reply "yes" to confirm or "no" to re-enter.`,
      );
    } catch (err) {
      this.logger.error('Bank verification failed during onboarding', err as Error);
      await this.send(from, "⚠️ Couldn't verify that account. Double-check the number and try again.");
    }
  }

  // ---------- Active seller commands ----------

  private async handleActiveCommand(from: string, seller: Seller, text: string) {
    if (/^help$/i.test(text)) {
      await this.send(
        from,
        [
          'Commands:',
          '• new order <buyer name> | <amount> | [buyer WhatsApp number]',
          '• orders - list pending orders',
          '• renew <order id> - get a fresh payment account if one expired',
          '• balance',
          '• withdraw <amount>',
        ].join('\n'),
      );
      return;
    }

    if (/^balance$/i.test(text)) {
      await this.send(from, `💼 Withdrawable balance: ₦${Number(seller.balance).toLocaleString()}`);
      return;
    }

    if (/^withdraw/i.test(text)) {
      await this.startWithdrawal(from, seller, text);
      return;
    }

    if (/^new order/i.test(text)) {
      await this.handleNewOrder(from, seller, text);
      return;
    }

    if (/^renew\s+/i.test(text)) {
      await this.handleRenew(from, seller, text);
      return;
    }

    if (/^orders$/i.test(text)) {
      await this.handleListPendingOrders(from, seller);
      return;
    }

    await this.send(from, 'Sorry, I didn\'t understand that. Send "help" to see available commands.');
  }

  private formatExpiry(expiresAt: Date | null | undefined): string {
    if (!expiresAt) return 'shortly';
    const msRemaining = new Date(expiresAt).getTime() - Date.now();
    if (msRemaining <= 0) return 'expired';
    const minutes = Math.max(1, Math.round(msRemaining / 60000));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  private async handleRenew(from: string, seller: Seller, text: string) {
    const shortId = text.replace(/^renew\s+/i, '').trim();
    const order = await this.ordersService.findPendingByShortId(seller.id, shortId);

    if (!order) {
      await this.send(from, `Couldn't find a pending order matching "${shortId}". Send "orders" to see pending orders.`);
      return;
    }

    try {
      const renewed = await this.ordersService.renewAccount(order.id);
      await this.send(
        from,
        [
          `🔄 Fresh payment account for *${renewed.buyerName}*:`,
          `Bank: ${renewed.monnifyBankName}`,
          `Account No: ${renewed.monnifyAccountNumber}`,
          `Account Name: ${renewed.monnifyAccountName}`,
          '',
          `⏱️ Expires in ${this.formatExpiry(renewed.accountExpiresAt)}.`,
        ].join('\n'),
      );
    } catch (err) {
      this.logger.error('Order renewal failed', err as Error);
      await this.send(from, '⚠️ Could not renew that order. Please try again.');
    }
  }

  private async handleListPendingOrders(from: string, seller: Seller) {
    const all = await this.ordersService.findAll();
    const pending = all.filter((o) => o.sellerId === seller.id && o.status === OrderStatus.PENDING);

    if (pending.length === 0) {
      await this.send(from, 'No pending orders.');
      return;
    }

    const lines = pending.map(
      (o) =>
        `• ${o.id.slice(-6)} - ${o.buyerName} - ₦${Number(o.amount).toLocaleString()} (expires in ${this.formatExpiry(o.accountExpiresAt)})`,
    );
    await this.send(from, ['Pending orders:', ...lines].join('\n'));
  }

  private async handleNewOrder(from: string, seller: Seller, text: string) {
    const withoutCommand = text.replace(/^new order/i, '').trim();
    const [namePart, amountPart, buyerWhatsappPart] = withoutCommand
      .split('|')
      .map((s) => s.trim());

    const amount = Number(amountPart);
    if (!namePart || Number.isNaN(amount) || amount <= 0) {
      await this.send(from, 'Format: "new order <buyer name> | <amount> | [buyer WhatsApp number]"');
      return;
    }

    try {
      const order = await this.ordersService.createOrder({
        sellerId: seller.id,
        buyerName: namePart,
        amount,
        buyerWhatsapp: buyerWhatsappPart || undefined,
      });

      await this.send(
        from,
        [
          `✅ Order created for *${order.buyerName}*`,
          `Amount: ₦${Number(order.amount).toLocaleString()}`,
          `MatchPay fee: ₦${Number(order.platformFee).toLocaleString()}`,
          `You'll receive: ₦${Number(order.netAmount).toLocaleString()}`,
          '',
          `Send this account to the buyer:`,
          `Bank: ${order.monnifyBankName}`,
          `Account No: ${order.monnifyAccountNumber}`,
          `Account Name: ${order.monnifyAccountName}`,
          '',
          `⏱️ This account expires in ${this.formatExpiry(order.accountExpiresAt)}. If it expires unpaid, use "renew ${order.id.slice(-6)}" to get a fresh one.`,
          '',
          `I'll message you the moment it's paid.`,
        ].join('\n'),
      );
    } catch (err) {
      this.logger.error('Failed to create order from WhatsApp command', err as Error);
      await this.send(from, '⚠️ Something went wrong creating that order. Please try again.');
    }
  }

  // ---------- Withdrawals ----------

  private async startWithdrawal(from: string, seller: Seller, text: string) {
    const amountText = text.replace(/^withdraw/i, '').trim();
    const amount = Number(amountText);

    if (Number.isNaN(amount) || amount <= 0) {
      await this.send(from, 'Format: "withdraw <amount>", e.g. "withdraw 5000"');
      return;
    }
    if (amount > Number(seller.balance)) {
      await this.send(
        from,
        `Insufficient balance. Your withdrawable balance is ₦${Number(seller.balance).toLocaleString()}.`,
      );
      return;
    }
    if (!seller.settlementAccountNumber) {
      await this.send(from, 'No verified bank account on file. Please contact support.');
      return;
    }

    this.pendingWithdrawals.set(from, { amount });
    await this.send(
      from,
      [
        `Confirm withdrawal of ₦${amount.toLocaleString()} to:`,
        `${seller.settlementAccountName} - ${seller.settlementAccountNumber}`,
        '',
        'Enter your 4-digit PIN to confirm, or reply "cancel".',
      ].join('\n'),
    );
  }

  private async handleWithdrawalPinEntry(from: string, seller: Seller, text: string) {
    const pending = this.pendingWithdrawals.get(from);
    if (!pending) return;

    if (/^cancel$/i.test(text)) {
      this.pendingWithdrawals.delete(from);
      await this.send(from, 'Withdrawal cancelled.');
      return;
    }

    if (!/^\d{4}$/.test(text)) {
      await this.send(from, 'Please enter your 4-digit PIN, or reply "cancel".');
      return;
    }

    let isValid: boolean;
    try {
      isValid = await this.sellersService.verifyPin(seller.id, text);
    } catch (err) {
      // verifyPin throws once the account is already locked.
      this.pendingWithdrawals.delete(from);
      await this.send(
        from,
        '🔒 Too many wrong PIN attempts. Your account is now locked - contact support to unlock it.',
      );
      return;
    }

    if (!isValid) {
      const refreshed = await this.sellersService.findById(seller.id);
      if (refreshed.status === SellerStatus.LOCKED) {
        this.pendingWithdrawals.delete(from);
        await this.send(
          from,
          '🔒 Too many wrong PIN attempts. Your account is now locked - contact support to unlock it.',
        );
        return;
      }
      await this.send(from, '❌ Incorrect PIN. Try again, or reply "cancel".');
      return;
    }

    this.pendingWithdrawals.delete(from);

    try {
      const withdrawal = await this.withdrawalsService.requestWithdrawal(seller, pending.amount);
      await this.send(
        from,
        [
          `✅ Withdrawal of ₦${pending.amount.toLocaleString()} initiated.`,
          `Status: ${withdrawal.status}`,
          `I'll confirm here once it lands in your account.`,
        ].join('\n'),
      );
    } catch (err) {
      this.logger.error('Withdrawal request failed', err as Error);
      await this.send(from, `⚠️ ${(err as Error).message || 'Withdrawal failed. Please try again.'}`);
    }
  }

  // ---------- Outbound notifications (called from webhook handlers) ----------

  async notifyOrderPaid(order: Order) {
    const seller = await this.sellersService.findById(order.sellerId);
    const sellerJid = `${seller.whatsappNumber}@s.whatsapp.net`;

    const sellerMessage = [
      `💰 Payment received!`,
      `Order: *${order.buyerName}* - ₦${Number(order.amount).toLocaleString()}`,
      `MatchPay fee: ₦${Number(order.platformFee).toLocaleString()}`,
      `Net to you: ₦${Number(order.netAmount).toLocaleString()}`,
      `New balance: ₦${Number(seller.balance).toLocaleString()}`,
      `Status: PAID ✅`,
      `Ref: ${order.monnifyTransactionReference}`,
    ].join('\n');

    await this.send(sellerJid, sellerMessage);

    if (order.buyerWhatsapp) {
      const buyerJid = `${order.buyerWhatsapp}@s.whatsapp.net`;
      await this.send(
        buyerJid,
        `Thank you! We've confirmed your payment of ₦${Number(order.amount).toLocaleString()}. Your order is being processed. 🎉`,
      );
    }
  }

  async notifyWithdrawalCompleted(sellerId: string, amount: number, success: boolean) {
    const seller = await this.sellersService.findById(sellerId);
    const sellerJid = `${seller.whatsappNumber}@s.whatsapp.net`;
    const message = success
      ? `✅ Withdrawal of ₦${amount.toLocaleString()} successful. It should reflect in your bank shortly.`
      : `❌ Withdrawal of ₦${amount.toLocaleString()} failed. The amount has been refunded to your MatchPay balance.`;
    await this.send(sellerJid, message);
  }

  private async send(jid: string, text: string) {
    if (!this.sock) {
      this.logger.warn('WhatsApp socket not ready, dropping message');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text });
    } catch (err) {
      this.logger.error(`Failed to send WhatsApp message to ${jid}`, err as Error);
    }
  }
}
