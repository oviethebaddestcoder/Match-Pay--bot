import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersModule } from './orders/orders.module';
import { MonnifyModule } from './monnify/monnify.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { EventsModule } from './events/events.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { SellersModule } from './sellers/sellers.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { Order } from './orders/order.entity';
import { Seller } from './sellers/seller.entity';
import { Withdrawal } from './withdrawals/withdrawal.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: process.env.DB_PATH || 'matchpay.sqlite',
      entities: [Order, Seller, Withdrawal],
      synchronize: true, // fine for a hackathon demo; use migrations in production
      // WAL mode lets reads happen without blocking on writes, and the busy
      // timeout makes a concurrent write wait briefly instead of immediately
      // failing with SQLITE_BUSY if two requests land at the same instant.
      prepareDatabase: (db: any) => {
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
      },
    }),
    MonnifyModule,
    OrdersModule,
    SellersModule,
    WithdrawalsModule,
    WebhooksModule,
    EventsModule,
    WhatsappModule,
  ],
})
export class AppModule {}
