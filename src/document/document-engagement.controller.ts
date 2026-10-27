import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth-user.interface';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PermissionCode } from '../common/constants/permissions';
import { DocumentSocialService } from './document-social.service';
import { DocumentShareService } from './document-share.service';
import { DocumentVersionService } from './document-version.service';
import { DocumentService } from './document.service';
import { CreateCommentDto, CreateShareDto } from './dto/social.dto';

function pageOf(page?: string, pageSize?: string) {
  return {
    page: Math.max(1, Number(page) || 1),
    pageSize: Math.min(100, Math.max(1, Number(pageSize) || 20)),
  };
}

@Controller('favorites')
export class FavoriteController {
  constructor(private readonly social: DocumentSocialService) {}

  @Get()
  @RequirePermission(PermissionCode.documentList)
  list(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const query = pageOf(page, pageSize);
    return this.social.listFavorites(user, query.page, query.pageSize);
  }
}

@Controller('documents')
export class DocumentEngagementController {
  constructor(
    private readonly social: DocumentSocialService,
    private readonly shareService: DocumentShareService,
    private readonly versions: DocumentVersionService,
    private readonly documents: DocumentService,
  ) {}

  @Post(':id/likes')
  @RequirePermission(PermissionCode.documentList)
  toggleLike(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.social.toggleLike(id, user);
  }

  @Post(':id/favorites')
  @RequirePermission(PermissionCode.documentList)
  toggleFavorite(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.social.toggleFavorite(id, user);
  }

  @Get(':id/comments')
  @RequirePermission(PermissionCode.documentList)
  comments(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.social.listComments(id, user);
  }

  @Post(':id/comments')
  @RequirePermission(PermissionCode.documentList)
  addComment(
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.social.addComment(id, dto, user);
  }

  @Delete(':id/comments/:commentId')
  @RequirePermission(PermissionCode.documentList)
  removeComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.social.removeComment(id, commentId, user);
  }

  @Get(':id/shares')
  @RequirePermission(PermissionCode.documentList)
  shares(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.shareService.list(id, user);
  }

  @Post(':id/shares')
  @RequirePermission(PermissionCode.documentList)
  createShare(
    @Param('id') id: string,
    @Body() dto: CreateShareDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.shareService.create(id, dto, user);
  }

  @Delete(':id/shares/:shareId')
  @RequirePermission(PermissionCode.documentList)
  revokeShare(
    @Param('id') id: string,
    @Param('shareId') shareId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.shareService.revoke(id, shareId, user);
  }

  @Get(':id/versions')
  @RequirePermission(PermissionCode.documentList, PermissionCode.documentVersion)
  versionsOf(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.versions.list(id, user);
  }

  @Post(':id/versions/:versionId/restore')
  @RequirePermission(PermissionCode.documentEdit, PermissionCode.documentVersion)
  async restore(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const version = await this.versions.get(id, versionId, user);
    return this.documents.update(
      id,
      {
        title: version.title,
        content: version.content,
        summary: version.summary ?? '',
      },
      user,
    );
  }
}
