import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Ip,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { GaslessService } from './gasless.service';
import { RequestVoucherDto } from './dto/request-voucher.dto';

// POST /voucher — 6 per IP per hour.
// Agents need exactly 1 batched POST per hour in steady state. The throttle
// is deliberately loose to absorb transient retries (failed chain calls,
// transient 5xx). The real anti-abuse gates are the per-wallet DB check
// (1h/wallet) and per-IP tranche ceiling (PER_IP_TRANCHES_PER_DAY).
const VOUCHER_THROTTLE = { default: { limit: 6, ttl: 3600000 } };

// GET /voucher/:account — 20 per IP per minute.
// Read-only state check, no VARA cost. Cheap enough that agents can poll
// mid-session to monitor balance without hitting the limit under honest use.
const VOUCHER_GET_THROTTLE = { default: { limit: 20, ttl: 60000 } };

@Controller()
export class GaslessController {
  constructor(
    private readonly service: GaslessService,
    private readonly configService: ConfigService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'vara-agent-network-voucher' };
  }

  @Get('info')
  getInfo(@Headers('x-api-key') apiKey: string) {
    const expected = this.configService.get<string>('infoApiKey');
    if (!expected) throw new ForbiddenException();

    // HMAC both sides to fixed-length digests — prevents length oracle
    const hmac = (v: string) =>
      createHmac('sha256', 'vara-agent-network-info').update(v).digest();
    if (!timingSafeEqual(hmac(apiKey ?? ''), hmac(expected))) {
      throw new ForbiddenException();
    }

    return this.service.getVoucherInfo();
  }

  @Post('voucher')
  @Throttle(VOUCHER_THROTTLE)
  async requestVoucher(
    @Body() body: RequestVoucherDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.requestVoucher(body, ip);
    if (result.status === 'rate_limited') {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      res.status(429);
      return result.body;
    }
    return { voucherId: result.voucherId };
  }

  @Get('voucher/:account')
  @Throttle(VOUCHER_GET_THROTTLE)
  getVoucherState(@Param('account') account: string) {
    return this.service.getVoucherState(account);
  }
}
