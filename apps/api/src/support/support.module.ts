import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { SupportService } from './support.service';

@Module({
  imports: [NotificationsModule],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
