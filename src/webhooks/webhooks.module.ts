import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { MonnifyModule } from '../monnify/monnify.module';
import { OrdersModule } from '../orders/orders.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';

@Module({
  imports: [MonnifyModule, OrdersModule, WhatsappModule, WithdrawalsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
