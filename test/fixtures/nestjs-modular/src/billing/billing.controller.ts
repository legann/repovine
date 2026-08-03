import { Controller, Get } from '@nestjs/common';

@Controller('billing')
export class BillingController {
  @Get('invoices')
  invoices() {}
}
