import { Global, Module } from '@nestjs/common';
import { PriceCacheService } from './price-cache.service';
import { RealtimeGateway } from './realtime.gateway';

@Global()
@Module({
  providers: [PriceCacheService, RealtimeGateway],
  exports: [PriceCacheService, RealtimeGateway],
})
export class RealtimeModule {}
