import { BadRequestException, Body, Controller, Logger, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { MonnifyService } from '../monnify/monnify.service';
import { OrdersService } from '../orders/orders.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';

@Controller('webhooks/monnify')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly monnify: MonnifyService,
    private readonly orders: OrdersService,
    private readonly whatsapp: WhatsappService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  @Post()
  async handleMonnifyWebhook(
    @Req() req: Request & { rawBody: Buffer },
    @Body() body: any,
  ) {
    const signature = req.headers['monnify-signature'] as string | undefined;
    const isValid = this.monnify.verifyWebhookSignature(
      req.rawBody?.toString('utf8') ?? '',
      signature,
    );

    if (!isValid) {
      this.logger.warn('Rejected webhook with invalid signature');
      throw new BadRequestException('Invalid webhook signature');
    }

    const eventType = body?.eventType;

    if (eventType === 'SUCCESSFUL_TRANSACTION') {
      return this.handlePaymentEvent(body);
    }

    if (eventType === 'SUCCESSFUL_DISBURSEMENT' || eventType === 'FAILED_DISBURSEMENT') {
      return this.handleDisbursementEvent(body, eventType === 'SUCCESSFUL_DISBURSEMENT');
    }

    return { received: true, ignored: true };
  }

  private async handlePaymentEvent(body: any) {
    const eventData = body?.eventData;
    // For the dynamic-account flow, Monnify echoes back the exact
    // paymentReference we set at transaction initialization - no
    // "reserved account funded" indirection needed.
    const paymentReference = eventData?.paymentReference;
    const transactionReference = eventData?.transactionReference;
    const amountPaid = Number(eventData?.amountPaid);

    if (!paymentReference) {
      this.logger.warn('Payment webhook missing paymentReference');
      return { received: true, matched: false };
    }

    const { order, newlyPaid } = await this.orders.markPaid({
      paymentReference,
      monnifyTransactionReference: transactionReference,
      amountPaid,
    });

    // Only fire the WhatsApp confirmation on the delivery that actually
    // transitioned the order - Monnify retries webhooks, and without this
    // check a retry would message the seller "payment received" twice.
    if (newlyPaid) {
      await this.whatsapp.notifyOrderPaid(order);
    }

    return { received: true, matched: true, orderId: order.id, newlyPaid };
  }

  private async handleDisbursementEvent(body: any, success: boolean) {
    const eventData = body?.eventData;
    // Monnify echoes back the reference we sent when initiating the transfer.
    const reference = eventData?.reference ?? eventData?.transactionReference;

    if (!reference) {
      this.logger.warn('Disbursement webhook missing reference');
      return { received: true, matched: false };
    }

    const { withdrawal, newlyFinalized } = await this.withdrawals.markCompleted(
      reference,
      success,
      success ? undefined : eventData?.responseMessage,
    );

    if (newlyFinalized) {
      await this.whatsapp.notifyWithdrawalCompleted(
        withdrawal.sellerId,
        Number(withdrawal.amount),
        success,
      );
    }

    return { received: true, matched: true, withdrawalId: withdrawal.id, newlyFinalized };
  }
}
