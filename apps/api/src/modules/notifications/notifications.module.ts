import { Global, Module } from '@nestjs/common';
import { ChannelSender } from './channels';
import { MailService } from './mail.service';
import { NotificationsController, NotificationsWorker, WebhooksController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  controllers: [NotificationsController, WebhooksController],
  providers: [MailService, ChannelSender, NotificationsService, NotificationsWorker],
  exports: [MailService, NotificationsService],
})
export class NotificationsModule {}
