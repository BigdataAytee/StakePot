import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { MetricsController } from './observability/metrics.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
