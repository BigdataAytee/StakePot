import { Module } from '@nestjs/common';

import { CommunityQuestionModule } from '../community/question-engine.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TradeModule } from '../trade/trade.module';
import { ResolutionFlowService } from './resolution-flow.service';

@Module({
  imports: [CommunityQuestionModule, NotificationsModule, TradeModule],
  providers: [ResolutionFlowService],
  exports: [ResolutionFlowService],
})
export class ResolutionModule {}
