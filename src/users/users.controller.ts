import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { InviteUserDto } from './dto/invite-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import type { PublicUser } from './public-user';
import {
  UsersService,
  type InviteResult,
  type UserPage,
} from './users.service';

// Account management is administrator-only; verified email is enforced globally.
@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  invite(@Body() dto: InviteUserDto): Promise<InviteResult> {
    return this.users.invite(dto);
  }

  @Get()
  list(@Query() query: ListUsersQueryDto): Promise<UserPage> {
    return this.users.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PublicUser> {
    return this.users.get(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<PublicUser> {
    return this.users.update(actor, id, dto);
  }
}
