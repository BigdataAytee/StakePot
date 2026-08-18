import { Module } from '@nestjs/common';

import { CommunityQuestionModule } from '../community/question-engine.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CommunityLayerModule } from '../community-layer/community-layer.module';
import { CreatorModule } from '../creator/creator.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TradeModule } from '../trade/trade.module';
import { ResolutionFlowService } from './resolution-flow.service';

@Module({
  imports: [
    AnalyticsModule,
    CommunityLayerModule,
    CommunityQuestionModule,
    CreatorModule,
    NotificationsModule,
    TradeModule,
  ],
  providers: [ResolutionFlowService],
  exports: [ResolutionFlowService],
})
export class ResolutionModule {}
