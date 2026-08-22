import { Global, Module } from '@nestjs/common';
import { AdminAuditService } from './admin-audit.service';
import { PiiAccessService } from './pii-access.service';

@Global()
@Module({
  providers: [AdminAuditService, PiiAccessService],
  exports: [AdminAuditService, PiiAccessService],
})
export class AuditModule {}
