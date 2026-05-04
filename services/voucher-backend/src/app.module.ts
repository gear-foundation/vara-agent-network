import { webcrypto } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { GaslessProgram } from './entities/gasless-program.entity';
import { Voucher } from './entities/voucher.entity';
import { IpTrancheUsage } from './entities/ip-tranche-usage.entity';
import { GaslessModule } from './gasless/gasless.module';
import configuration from './config/configuration';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as typeof globalThis.crypto;
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 3600000, limit: 100 }]),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('database.host'),
        port: config.get('database.port'),
        username: config.get('database.user'),
        password: config.get('database.password'),
        database: config.get('database.name'),
        entities: [GaslessProgram, Voucher, IpTrancheUsage],
        // synchronize:true is safe for initial dev/deploy. Disable for production
        // once the schema is stable and switch to explicit migrations.
        synchronize: process.env.NODE_ENV !== 'production',
      }),
      inject: [ConfigService],
    }),
    GaslessModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
