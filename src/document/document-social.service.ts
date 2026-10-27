import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import type { AuthUser } from '../auth/auth-user.interface';
import { RoleCode } from '../common/constants/roles';
import { accessFromUser, canReadDocument } from './document-access';
import { DocumentEntity } from './entities/document.entity';
import { CommentEntity } from './entities/comment.entity';
import { DocumentLikeEntity } from './entities/document-like.entity';
import { DocumentFavoriteEntity } from './entities/document-favorite.entity';
import { CreateCommentDto } from './dto/social.dto';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class DocumentSocialService {
  private readonly logger = new Logger(DocumentSocialService.name);

  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    private readonly notifications: NotificationService,
  ) {}

  async flags(documentId: string, userId: string) {
    const [likeRow, favoriteRow] = await Promise.all([
      this.em.findOne(DocumentLikeEntity, {
        where: { documentId, userId },
      }),
      this.em.findOne(DocumentFavoriteEntity, {
        where: { documentId, userId },
      }),
    ]);
    return { liked: Boolean(likeRow), favorited: Boolean(favoriteRow) };
  }

  async toggleLike(documentId: string, user: AuthUser) {
    const doc = await this.requireReadable(documentId, user);
    const existing = await this.em.findOne(DocumentLikeEntity, {
      where: { documentId, userId: user.userId },
    });
    if (existing) {
      await this.em.delete(DocumentLikeEntity, { id: existing.id });
      doc.likeCount = Math.max(0, (doc.likeCount ?? 0) - 1);
    } else {
      await this.em.save(
        this.em.create(DocumentLikeEntity, {
          id: nextSnowflakeId(),
          documentId,
          userId: user.userId,
        }),
      );
      doc.likeCount = (doc.likeCount ?? 0) + 1;
      await this.notifyAuthor(doc, user, 'like');
    }
    await this.em.update(
      DocumentEntity,
      { id: documentId },
      { likeCount: doc.likeCount },
    );
    return { liked: !existing, likeCount: doc.likeCount };
  }

  async toggleFavorite(documentId: string, user: AuthUser) {
    const doc = await this.requireReadable(documentId, user);
    const existing = await this.em.findOne(DocumentFavoriteEntity, {
      where: { documentId, userId: user.userId },
    });
    if (existing) {
      await this.em.delete(DocumentFavoriteEntity, { id: existing.id });
      doc.favouriteCount = Math.max(0, (doc.favouriteCount ?? 0) - 1);
    } else {
      await this.em.save(
        this.em.create(DocumentFavoriteEntity, {
          id: nextSnowflakeId(),
          documentId,
          userId: user.userId,
        }),
      );
      doc.favouriteCount = (doc.favouriteCount ?? 0) + 1;
    }
    await this.em.update(
      DocumentEntity,
      { id: documentId },
      { favouriteCount: doc.favouriteCount },
    );
    return { favorited: !existing, favouriteCount: doc.favouriteCount };
  }

  async listFavorites(user: AuthUser, page = 1, pageSize = 20) {
    const favs = await this.em.find(DocumentFavoriteEntity, {
      where: { userId: user.userId },
      order: { createdAt: 'DESC' },
    });
    if (!favs.length) return { items: [], total: 0, page, pageSize };
    const docs = await this.em.find(DocumentEntity, {
      where: { id: In(favs.map((f) => f.documentId)), deleted: false },
    });
    const byId = new Map(docs.map((doc) => [doc.id, doc]));
    const scope = accessFromUser(user);
    const visible = favs
      .map((fav) => byId.get(fav.documentId))
      .filter((doc): doc is DocumentEntity => Boolean(doc))
      .filter((doc) => canReadDocument(doc, scope));
    const start = (page - 1) * pageSize;
    return {
      items: visible.slice(start, start + pageSize),
      total: visible.length,
      page,
      pageSize,
    };
  }

  async listComments(documentId: string, user: AuthUser) {
    await this.requireReadable(documentId, user);
    return this.em.find(CommentEntity, {
      where: { documentId, deleted: false },
      order: { createdAt: 'ASC' },
    });
  }

  async addComment(documentId: string, dto: CreateCommentDto, user: AuthUser) {
    const doc = await this.requireReadable(documentId, user);
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('评论不能为空');
    let parentId: string | null = null;
    if (dto.parentId) {
      const parent = await this.em.findOne(CommentEntity, {
        where: { id: dto.parentId, documentId, deleted: false },
      });
      if (!parent) throw new BadRequestException('回复的评论不存在');
      if (parent.parentId) throw new BadRequestException('只能回复顶层评论');
      parentId = parent.id;
    }
    const comment = await this.em.save(
      this.em.create(CommentEntity, {
        id: nextSnowflakeId(),
        documentId,
        userId: user.userId,
        userName: (user.realName || user.username).slice(0, 50),
        content,
        parentId,
        deleted: false,
      }),
    );
    doc.commentCount = (doc.commentCount ?? 0) + 1;
    await this.em.update(
      DocumentEntity,
      { id: documentId },
      { commentCount: doc.commentCount },
    );
    await this.notifyAuthor(doc, user, 'comment', content);
    return { comment, commentCount: doc.commentCount };
  }

  async removeComment(documentId: string, commentId: string, user: AuthUser) {
    await this.requireReadable(documentId, user);
    const comment = await this.em.findOne(CommentEntity, {
      where: { id: commentId, documentId, deleted: false },
    });
    if (!comment) throw new NotFoundException('评论不存在');
    const isAdmin = user.roles?.includes(RoleCode.ADMIN);
    if (!isAdmin && comment.userId !== user.userId) {
      throw new ForbiddenException('只能删除自己的评论');
    }
    const replies = await this.em.find(CommentEntity, {
      where: { documentId, parentId: comment.id, deleted: false },
    });
    const ids = [comment.id, ...replies.map((row) => row.id)];
    await this.em.update(CommentEntity, { id: In(ids) }, { deleted: true });
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id: documentId, deleted: false },
    });
    const commentCount = Math.max(0, (doc?.commentCount ?? 0) - ids.length);
    if (doc) {
      await this.em.update(DocumentEntity, { id: documentId }, { commentCount });
    }
    return { commentCount };
  }

  private async notifyAuthor(
    doc: DocumentEntity,
    actor: AuthUser,
    type: 'like' | 'comment',
    comment?: string,
  ) {
    if (!doc.authorId || doc.authorId === actor.userId) return;
    const name = actor.realName || actor.username;
    const title = doc.title || '文档';
    const excerpt = comment ? comment.replace(/\s+/g, ' ').slice(0, 80) : '';
    try {
      await this.notifications.notify({
        userId: doc.authorId,
        type,
        title: type === 'like' ? `${name} 赞了你的文档` : `${name} 评论了你的文档`,
        content:
          type === 'like'
            ? `《${title}》`
            : `《${title}》${excerpt ? `：${excerpt}` : ''}`,
        documentId: doc.id,
        senderId: actor.userId,
        senderName: name,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`写入通知失败：documentId=${doc.id}, ${message}`);
    }
  }

  private async requireReadable(documentId: string, user: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id: documentId, deleted: false },
    });
    if (!doc) throw new NotFoundException('文档不存在');
    if (!canReadDocument(doc, accessFromUser(user))) {
      throw new ForbiddenException('无权查看该文档');
    }
    return doc;
  }
}
