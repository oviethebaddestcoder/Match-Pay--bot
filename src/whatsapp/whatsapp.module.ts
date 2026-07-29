import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { OrdersModule } from '../orders/orders.module';
import { SellersModule } from '../sellers/sellers.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { MonnifyModule } from '../monnify/monnify.module';

@Module({
  imports: [OrdersModule, SellersModule, WithdrawalsModule, MonnifyModule],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
