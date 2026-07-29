import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Withdrawal } from './withdrawal.entity';
import { WithdrawalsService } from './withdrawals.service';
import { SellersModule } from '../sellers/sellers.module';
import { MonnifyModule } from '../monnify/monnify.module';

@Module({
  imports: [TypeOrmModule.forFeature([Withdrawal]), SellersModule, MonnifyModule],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
