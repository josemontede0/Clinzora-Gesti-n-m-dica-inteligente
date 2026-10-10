import { Module } from '@nestjs/common';
import { InsuranceModule } from '../insurance/insurance.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ imports: [InsuranceModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
