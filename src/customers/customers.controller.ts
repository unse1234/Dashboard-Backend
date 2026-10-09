import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CustomerNumberParam } from './customer-id.param';
import type { CustomerDetailsDto } from './customer.mapper';
import { CustomersService, type CustomerPage } from './customers.service';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';

// Read-only. Every dashboard role may view customers, as the sidebar shows;
// verified email is enforced globally.
@Roles('ADMIN', 'STAFF')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query() query: ListCustomersQueryDto): Promise<CustomerPage> {
    return this.customers.list(query);
  }

  @Get(':customerId')
  get(@CustomerNumberParam() number: number): Promise<CustomerDetailsDto> {
    return this.customers.getDetails(number);
  }
}
