import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { TradeModule } from '../trade/trade.module';
import { ResolutionFlowService } from './resolution-flow.service';

@Module({
  imports: [NotificationsModule, TradeModule],
  providers: [ResolutionFlowService],
  exports: [ResolutionFlowService],
})
export class ResolutionModule {}
