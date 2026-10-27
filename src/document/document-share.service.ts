import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { EntityManager } from 'typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { nextSnowflakeId } from '../common/snowflake-id';
import type { AuthUser } from '../auth/auth-user.interface';
import {
  accessFromUser,
  canReadDocument,
  canWriteDocument,
} from './document-access';
import { DocumentStatus } from './document-status';
import { DocumentEntity } from './entities/document.entity';
import { DocumentShareEntity } from './entities/document-share.entity';
import {
  DocumentContent,
  DocumentContentDocument,
} from './schemas/document-content.schema';
import { AccessShareDto, CreateShareDto } from './dto/social.dto';

@Injectable()
export class DocumentShareService {
  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
  ) {}

  async create(documentId: string, dto: CreateShareDto, user: AuthUser) {
    const doc = await this.requireShareable(documentId, user);
    const password = dto.password?.trim();
    // 未传有效天数则永不过期；否则过期时间 = 现在 + expireDays 天
    const expireAt = dto.expireDays
      ? new Date(Date.now() + dto.expireDays * 24 * 60 * 60 * 1000)
      : null;
    const row = await this.em.save(
      this.em.create(DocumentShareEntity, {
        id: nextSnowflakeId(),
        documentId: doc.id,
        token: await this.newCode(),
        requirePassword: Boolean(password),
        passwordHash: password ? await hash(password, 10) : null,
        expireAt,
        createdBy: user.userId,
        revoked: false,
      }),
    );
    return this.toView(row);
  }

  async list(documentId: string, user: AuthUser) {
    const doc = await this.requireReadable(documentId, user);
    if (!canWriteDocument(doc, user)) {
      throw new ForbiddenException('只有作者或管理员可以管理分享');
    }
    const rows = await this.em.find(DocumentShareEntity, {
      where: { documentId, revoked: false },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => this.toView(row));
  }

  async revoke(documentId: string, shareId: string, user: AuthUser) {
    const doc = await this.requireReadable(documentId, user);
    if (!canWriteDocument(doc, user)) {
      throw new ForbiddenException('只有作者或管理员可以关闭分享');
    }
    const row = await this.em.findOne(DocumentShareEntity, {
      where: { id: shareId, documentId, revoked: false },
    });
    if (!row) throw new NotFoundException('分享不存在');
    row.revoked = true;
    await this.em.save(row);
    return { id: shareId };
  }

  async preview(code: string) {
    const row = await this.findActive(code);
    return {
      code: row.token,
      title: row.title,
      needPassword: Boolean(row.passwordHash),
      expireAt: row.expireAt ?? null,
    };
  }

  async access(code: string, dto: AccessShareDto) {
    const row = await this.findActive(code);
    if (row.passwordHash) {
      const password = dto.password?.trim() ?? '';
      if (!password || !(await compare(password, row.passwordHash))) {
        throw new ForbiddenException('分享密码不正确');
      }
    }
    const contentDoc = await this.contentModel
      .findOne({ _id: row.contentId, deleted: false })
      .lean();
    return {
      title: row.title,
      summary: row.summary ?? null,
      content: contentDoc?.content ?? '',
      expireAt: row.expireAt ?? null,
    };
  }

  private async findActive(code: string) {
    const row = await this.em.findOne(DocumentShareEntity, {
      where: { token: code, revoked: false },
    });
    if (!row) throw new NotFoundException('分享链接不存在或已关闭');
    if (row.expireAt && row.expireAt.getTime() < Date.now()) {
      throw new BadRequestException('分享链接已过期');
    }
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id: row.documentId, deleted: false },
    });
    if (!doc || doc.status !== DocumentStatus.Published) {
      throw new NotFoundException('文档未发布，分享暂不可用');
    }
    return { ...row, title: doc.title, summary: doc.summary, contentId: doc.contentId };
  }

  private toView(row: DocumentShareEntity) {
    return {
      id: row.id,
      documentId: row.documentId,
      code: row.token,
      needPassword: Boolean(row.passwordHash),
      expireAt: row.expireAt ?? null,
      createdAt: row.createdAt,
    };
  }

  private async newCode() {
    for (let i = 0; i < 5; i += 1) {
      const token = randomBytes(9).toString('base64url').slice(0, 12);
      const exists = await this.em.findOne(DocumentShareEntity, {
        where: { token },
      });
      if (!exists) return token;
    }
    throw new BadRequestException('生成分享码失败，请重试');
  }

  private async requireShareable(documentId: string, user: AuthUser) {
    const doc = await this.requireReadable(documentId, user);
    if (doc.status !== DocumentStatus.Published) {
      throw new BadRequestException('只有已发布的文档可以分享');
    }
    return doc;
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
