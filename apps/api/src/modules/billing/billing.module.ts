import { Module } from '@nestjs/common';
import { PatientsModule } from '../patients/patients.module';
import { BillingController } from './billing.controller';
import { CardTerminal } from './card-terminal';
import { CashService } from './cash.service';
import { ChargesService } from './charges.service';
import { FiscalService } from './fiscal.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';

@Module({
  imports: [PatientsModule],
  controllers: [BillingController],
  providers: [ChargesService, InvoicesService, PaymentsService, CashService, FiscalService, CardTerminal],
  exports: [ChargesService, InvoicesService, PaymentsService, FiscalService],
})
export class BillingModule {}
