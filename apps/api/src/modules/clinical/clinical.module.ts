import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { ClinicalController } from './clinical.controller';
import { ClinicalService } from './clinical.service';

@Module({ imports: [BillingModule], controllers: [ClinicalController], providers: [ClinicalService] })
export class ClinicalModule {}
