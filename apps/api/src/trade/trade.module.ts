import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RgModule } from '../rg/rg.module';
import { MarketService } from '../market/market.service';
import { WalletModule } from '../wallet/wallet.module';
import { ResolutionService } from './resolution.service';
import { TradeService } from './trade.service';

@Module({
  imports: [LedgerModule, RgModule, WalletModule],
  providers: [MarketService, TradeService, ResolutionService],
  exports: [MarketService, TradeService, ResolutionService],
})
export class TradeModule {}
