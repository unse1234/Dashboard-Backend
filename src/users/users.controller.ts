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
import { toPublicUser, type PublicUser } from './public-user';
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

  // Must stay above `:id`: Express matches in declaration order, so otherwise
  // "me" would be captured as an id and rejected by ParseUUIDPipe.
  // An empty @Roles() overrides the class-level ADMIN restriction (RolesGuard
  // treats no roles as "any signed-in user"); JwtAuthGuard still applies.
  @Roles()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): PublicUser {
    // The guard already loaded this user through publicUserSelect in the same
    // query that validated the session; toPublicUser drops the sessionId.
    return toPublicUser(user);
  }

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
