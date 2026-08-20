import { Module } from '@nestjs/common';
import { CommunityLayerModule } from '../community-layer/community-layer.module';
import { LedgerModule } from '../ledger/ledger.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderBookModule } from '../orderbook/orderbook.module';
import { RgModule } from '../rg/rg.module';
import { MarketService } from '../market/market.service';
import { WalletModule } from '../wallet/wallet.module';
import { ResolutionService } from './resolution.service';
import { TradeQueueService } from './trade-queue.service';
import { TradeService } from './trade.service';

@Module({
  imports: [
    CommunityLayerModule,
    LedgerModule,
    NotificationsModule,
    OrderBookModule,
    RgModule,
    WalletModule,
  ],
  providers: [MarketService, TradeQueueService, TradeService, ResolutionService],
  exports: [MarketService, OrderBookModule, TradeQueueService, TradeService, ResolutionService],
})
export class TradeModule {}
