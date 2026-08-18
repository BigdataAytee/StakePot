import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletService } from './wallet.service';

@Module({
  imports: [LedgerModule],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
