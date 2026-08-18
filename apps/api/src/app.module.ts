import { Module } from '@nestjs/common';

import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { LedgerModule } from './ledger/ledger.module';
import { MetricsController } from './observability/metrics.controller';
import { PlatformConfigModule } from './platform-config/platform-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { HttpModule } from './http/http.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TradeModule } from './trade/trade.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    PrismaModule,
    PlatformConfigModule,
    AuditModule,
    LedgerModule,
    WalletModule,
    AuthModule,
    ReconciliationModule,
    TradeModule,
    RealtimeModule,
    HttpModule,
  ],
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
