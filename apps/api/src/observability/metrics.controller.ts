import { Controller, Get, Header } from '@nestjs/common';
import { collectDefaultMetrics, register } from 'prom-client';

collectDefaultMetrics({ register });

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', register.contentType)
  async scrape(): Promise<string> {
    return register.metrics();
  }
}
