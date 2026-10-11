import { Global, Module } from '@nestjs/common';
import { PublicDisplayController, QueueController } from './queue.controller';
import { QueueService } from './queue.service';

@Global()
@Module({ controllers: [QueueController, PublicDisplayController], providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
