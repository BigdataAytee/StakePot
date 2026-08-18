import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { StatusModule } from '../status/status.module';
import { AbuseService } from './abuse.service';
import { LedgerAuditService } from './ledger-audit.service';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

/**
 * §2.7 and §12's hardening: the controls that stop the platform being used
 * faster than it is meant to be, and the ones that notice when it has been.
 */
@Module({
  imports: [AuditModule, StatusModule],
  providers: [RateLimitService, RateLimitGuard, AbuseService, LedgerAuditService],
  exports: [RateLimitService, RateLimitGuard, AbuseService, LedgerAuditService],
})
export class HardeningModule {}
