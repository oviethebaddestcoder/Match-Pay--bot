import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Order, OrderStatus } from './order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { MonnifyService } from '../monnify/monnify.service';
import { OrdersGateway } from '../events/orders.gateway';
import { calculateFee } from './fee.util';
import { SellersService } from '../sellers/sellers.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order) private readonly ordersRepo: Repository<Order>,
    private readonly monnify: MonnifyService,
    private readonly gateway: OrdersGateway,
    private readonly sellers: SellersService,
  ) {}

  /**
   * Creates an order AND a dedicated Monnify virtual account for it in one step.
   * The accountReference is what ties a future webhook back to this exact order.
   */
  async createOrder(dto: CreateOrderDto): Promise<Order> {
    const paymentReference = `matchpay-${uuidv4()}`;

    const account = await this.monnify.createDynamicAccountForOrder({
      paymentReference,
      amount: dto.amount,
      customerEmail: `${paymentReference}@matchpay.demo`, // Monnify requires an email; synthetic is fine for a one-time buyer
      customerName: dto.buyerName,
    });

    const { platformFee, netAmount } = calculateFee(dto.amount);

    const order = this.ordersRepo.create({
      sellerId: dto.sellerId,
      buyerName: dto.buyerName,
      buyerWhatsapp: dto.buyerWhatsapp,
      amount: dto.amount,
      platformFee,
      netAmount,
      paymentReference,
      monnifyAccountNumber: account.accountNumber,
      monnifyAccountName: account.accountName,
      monnifyBankName: account.bankName,
      monnifyTransactionReference: account.monnifyTransactionReference,
      accountExpiresAt: new Date(Date.now() + account.expiresInSeconds * 1000),
      status: OrderStatus.PENDING,
    });

    const saved = await this.ordersRepo.save(order);
    this.gateway.emitOrderCreated(saved);
    return saved;
  }

  /**
   * Generates a fresh dynamic account for a PENDING order whose payment
   * window has lapsed. A new paymentReference is used (Monnify dynamic
   * accounts aren't reusable past expiry) and stored on the SAME order
   * row, so order history and any prior buyer communication about this
   * order stay intact - only the payment destination changes.
   */
  async renewAccount(orderId: string): Promise<Order> {
    const order = await this.findOne(orderId);
    if (order.status !== OrderStatus.PENDING) {
      throw new Error('Only pending orders can be renewed');
    }

    const paymentReference = `matchpay-${uuidv4()}`;
    const account = await this.monnify.createDynamicAccountForOrder({
      paymentReference,
      amount: Number(order.amount),
      customerEmail: `${paymentReference}@matchpay.demo`,
      customerName: order.buyerName,
    });

    order.paymentReference = paymentReference;
    order.monnifyAccountNumber = account.accountNumber;
    order.monnifyAccountName = account.accountName;
    order.monnifyBankName = account.bankName;
    order.monnifyTransactionReference = account.monnifyTransactionReference;
    order.accountExpiresAt = new Date(Date.now() + account.expiresInSeconds * 1000);

    return this.ordersRepo.save(order);
  }

  async findByPaymentReference(paymentReference: string): Promise<Order | null> {
    return this.ordersRepo.findOne({ where: { paymentReference } });
  }

  /** Finds a seller's pending order whose id ends with the given short suffix. */
  async findPendingByShortId(sellerId: string, shortId: string): Promise<Order | null> {
    const pending = await this.ordersRepo.find({
      where: { sellerId, status: OrderStatus.PENDING },
    });
    return (
      pending.find((o) => o.id.toLowerCase().endsWith(shortId.toLowerCase())) ?? null
    );
  }

  async findAll(): Promise<Order[]> {
    return this.ordersRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.ordersRepo.findOne({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Called by the webhook handler once a payment is confirmed.
   * This is the actual "reconciliation" moment - one order, marked paid,
   * with no manual matching required.
   *
   * Returns `newlyPaid: false` when this call lost a race against another
   * delivery of the same webhook (Monnify does retry) or a previous call -
   * the caller (the webhook controller) uses that to avoid double-crediting
   * the seller's wallet or sending a duplicate WhatsApp notification.
   */
  async markPaid(params: {
    paymentReference: string;
    monnifyTransactionReference: string;
    amountPaid: number;
  }): Promise<{ order: Order; newlyPaid: boolean }> {
    const order = await this.findByPaymentReference(params.paymentReference);
    if (!order) {
      this.logger.warn(
        `Received payment for unknown paymentReference: ${params.paymentReference}`,
      );
      throw new NotFoundException(
        `No order found for paymentReference ${params.paymentReference}`,
      );
    }

    // Underpayment guard: log loudly rather than silently treating a short
    // payment as fully settled. Doesn't block the transition - a seller
    // still needs to know the money arrived - but the discrepancy is
    // visible in logs for follow-up rather than swallowed.
    if (Number.isFinite(params.amountPaid) && params.amountPaid < Number(order.amount) * 0.99) {
      this.logger.warn(
        `Order ${order.id} expected ₦${order.amount} but webhook reports ₦${params.amountPaid} paid - underpayment, review manually`,
      );
    }

    // Atomic conditional transition: only succeeds if the order is still
    // NOT already PAID. If two webhook deliveries for the same payment
    // race each other, only one UPDATE can match - the other affects 0
    // rows, so we know precisely not to double-credit the wallet.
    const result = await this.ordersRepo
      .createQueryBuilder()
      .update(Order)
      .set({
        status: OrderStatus.PAID,
        paidAt: new Date(),
        monnifyTransactionReference: params.monnifyTransactionReference,
      })
      .where('id = :id AND status != :paid')
      .setParameters({ id: order.id, paid: OrderStatus.PAID })
      .execute();

    const newlyPaid = (result.affected ?? 0) > 0;

    if (newlyPaid) {
      // Credit the seller's withdrawable wallet with the NET amount
      // (gross minus MatchPay's platform fee), not the gross amount.
      await this.sellers.creditBalance(order.sellerId, Number(order.netAmount));
    }

    const finalOrder = await this.findOne(order.id);
    if (newlyPaid) {
      this.gateway.emitOrderPaid(finalOrder);
    }
    return { order: finalOrder, newlyPaid };
  }
}
