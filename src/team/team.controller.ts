import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { TeamService } from './team.service';
import {
  CreateTeamDto,
  QueryTeamDto,
  UpdateTeamDto,
} from './dto/team.dto';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RoleCode } from '../common/constants/roles';

@Controller('teams')
@Roles(RoleCode.ADMIN)
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Post()
  @RequirePermission('system:team')
  create(@Body() dto: CreateTeamDto) {
    return this.teamService.create(dto);
  }

  @Put(':id')
  @RequirePermission('system:team')
  update(@Param('id') id: string, @Body() dto: UpdateTeamDto) {
    return this.teamService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('system:team')
  async delete(@Param('id') id: string) {
    await this.teamService.delete(id);
    return { message: '删除成功' };
  }

  @Get('page')
  @RequirePermission('system:team')
  page(@Query() query: QueryTeamDto) {
    return this.teamService.page(query);
  }

  @Public()
  @Get('tree')
  getTree(@Query('rootOnly') rootOnly?: string) {
    return this.teamService.getTree(rootOnly === 'true');
  }

  @Get(':id')
  @RequirePermission('system:team')
  getDetail(@Param('id') id: string) {
    return this.teamService.getDetail(id);
  }

  @Post(':id/members')
  @RequirePermission('system:team')
  addMembers(@Param('id') id: string, @Body() userIds: string[]) {
    return this.teamService.addMembers(id, userIds);
  }

  @Delete(':id/members')
  @RequirePermission('system:team')
  removeMembers(@Param('id') id: string, @Body() userIds: string[]) {
    return this.teamService.removeMembers(id, userIds);
  }

  @Get(':id/members')
  @RequirePermission('system:team')
  listMembers(@Param('id') id: string) {
    return this.teamService.listMembers(id);
  }
}
