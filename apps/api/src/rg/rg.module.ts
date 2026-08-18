import { Module } from '@nestjs/common';

import { RgService } from './rg.service';

@Module({
  providers: [RgService],
  exports: [RgService],
})
export class RgModule {}
