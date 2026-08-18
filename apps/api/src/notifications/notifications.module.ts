import { Module } from '@nestjs/common';

import { EmailSender } from './email.sender';
import { NotificationsService } from './notifications.service';
import { PushSender } from './push.sender';
import { SmsSender } from './sms.sender';

@Module({
  providers: [NotificationsService, PushSender, EmailSender, SmsSender],
  exports: [NotificationsService],
})
export class NotificationsModule {}
