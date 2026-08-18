import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger/ledger.module';
import { SolvencyService } from './solvency.service';

@Module({
  imports: [LedgerModule],
  providers: [SolvencyService],
  exports: [SolvencyService],
})
export class AdminModule {}
