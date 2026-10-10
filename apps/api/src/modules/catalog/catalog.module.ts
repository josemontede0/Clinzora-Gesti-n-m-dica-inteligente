import { Global, Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { PricingService } from './pricing.service';

@Global()
@Module({ controllers: [CatalogController], providers: [PricingService], exports: [PricingService] })
export class CatalogModule {}
