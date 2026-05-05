import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { GaslessProgram } from '../entities/gasless-program.entity';
import { Voucher } from '../entities/voucher.entity';
import { IpTrancheUsage } from '../entities/ip-tranche-usage.entity';
import { GaslessService } from './gasless.service';
import { GaslessController } from './gasless.controller';
import { VoucherService } from './voucher.service';
import { VoucherTask } from './voucher.task';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([GaslessProgram, Voucher, IpTrancheUsage]),
  ],
  controllers: [GaslessController],
  providers: [GaslessService, VoucherService, VoucherTask],
  exports: [GaslessService, VoucherService],
})
export class GaslessModule {}
