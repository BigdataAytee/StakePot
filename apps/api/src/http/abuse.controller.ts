import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AbuseError, AbuseService } from '../hardening/abuse.service';
import { LedgerAuditService } from '../hardening/ledger-audit.service';

export class DecideDto {
  @IsIn(['freeze', 'clear', 'unfreeze']) decision!: 'freeze' | 'clear' | 'unfreeze';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class DeviceDto {
  @IsString() @MinLength(8) @MaxLength(128) fingerprint!: string;
}

/**
 * §6.5's abuse queue and §2.7's ledger audit, over HTTP.
 *
 * Behind the role matrix: Trust & Safety works the queue, and the audit is
 * readable by anybody who would be woken by it. Nothing here moves money —
 * freezing an account stops it opening positions and leaves the balance exactly
 * where it is, because balance changes go through §2.10's approvals workflow
 * and nowhere else.
 */
@Controller('admin/abuse')
@UseGuards(JwtGuard, RolesGuard)
@Roles('trust_safety', 'admin')
export class AbuseController {
  constructor(
    private readonly abuse: AbuseService,
    private readonly audit: LedgerAuditService,
  ) {}

  @Get()
  async queue(@Query('state') state?: string) {
    const parsed = state === 'actioned' || state === 'cleared' || state === 'open' ? state : 'open';
    return this.abuse.queue({ state: parsed });
  }

  /** Run the rules now rather than waiting for the hourly sweep. */
  @Post('sweep')
  async sweep() {
    return this.abuse.sweep();
  }

  @Post(':id')
  async decide(
    @Req() request: RequestWithUser,
    @Param('id') flagId: string,
    @Body() body: DecideDto,
  ) {
    try {
      return await this.abuse.decide({
        flagId,
        staffId: request.user!.userId,
        decision: body.decision,
        ...(body.note === undefined ? {} : { note: body.note }),
        ip: request.ip ?? 'unknown',
      });
    } catch (caught) {
      if (caught instanceof AbuseError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  /**
   * §2.7's ledger audit, on demand.
   *
   * The same checks the six-hourly job runs. Exposed because the first thing
   * anybody does after a suspected incident is ask whether the money still adds
   * up, and waiting for the next scheduled run is not an answer.
   */
  @Get('ledger-audit')
  @Roles('finance', 'admin', 'trust_safety')
  async ledgerAudit() {
    const result = await this.audit.run();
    return {
      ranAt: result.ranAt.toISOString(),
      checks: result.checks,
      clean: result.clean,
      findings: result.findings,
    };
  }
}

/**
 * The device signal §2.1 and §2.7 ask for, recorded by the client.
 *
 * Deliberately a hint and never a gate: fingerprints collide between honest
 * people on the same handset and browser, so this feeds a queue a human reads
 * rather than a rule that blocks a signup. Nothing is refused on the strength
 * of it, which is also why it is safe for the client to send.
 */
@Controller('me/device')
@UseGuards(JwtGuard)
export class DeviceController {
  constructor(private readonly abuse: AbuseService) {}

  @Post()
  async record(@Req() request: RequestWithUser, @Body() body: DeviceDto) {
    await this.abuse.recordDevice({
      userId: request.user!.userId,
      fingerprint: body.fingerprint,
    });
    return { recorded: true };
  }
}
