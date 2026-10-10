import { Module } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { InsuranceController } from './insurance.controller';

@Module({ controllers: [InsuranceController], providers: [ClaimsService], exports: [ClaimsService] })
export class InsuranceModule {}
