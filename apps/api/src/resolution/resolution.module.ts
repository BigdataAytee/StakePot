import { Module } from '@nestjs/common';

import { TradeModule } from '../trade/trade.module';
import { ResolutionFlowService } from './resolution-flow.service';

@Module({
  imports: [TradeModule],
  providers: [ResolutionFlowService],
  exports: [ResolutionFlowService],
})
export class ResolutionModule {}
