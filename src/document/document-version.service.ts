import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import type { AuthUser } from '../auth/auth-user.interface';
import { canWriteDocument } from './document-access';
import { DocumentEntity } from './entities/document.entity';
import { DocumentVersionEntity } from './entities/document-version.entity';
import { stripNullBytes } from './parser/utils/markdown.util';

type VersionSnapshot = {
  documentId: string;
  version: number;
  title: string;
  content: string;
  summary?: string | null;
  wordCount: number;
  userId?: string | null;
};

@Injectable()
export class DocumentVersionService {
  constructor(@InjectEntityManager() private readonly em: EntityManager) {}

  /**
   * 正文变更后记一条新版本。
   * 这份文档还没有任何历史时，先把改之前的正文记下来，避免第一次编辑把旧稿盖掉。
   */
  async recordContentChange(input: {
    previous: VersionSnapshot;
    next: VersionSnapshot;
  }) {
    const count = await this.em.count(DocumentVersionEntity, {
      where: { documentId: input.next.documentId },
    });
    if (count === 0) {
      await this.insertIgnore(input.previous);
    }
    if (input.next.version !== input.previous.version) {
      await this.insertIgnore(input.next);
    }
  }

  async recordInitial(snapshot: VersionSnapshot) {
    await this.insertIgnore(snapshot);
  }

  async list(documentId: string, user: AuthUser) {
    await this.requireWriter(documentId, user);
    return this.em.find(DocumentVersionEntity, {
      where: { documentId },
      order: { version: 'DESC' },
    });
  }

  async get(documentId: string, versionId: string, user: AuthUser) {
    await this.requireWriter(documentId, user);
    const row = await this.em.findOne(DocumentVersionEntity, {
      where: { id: versionId, documentId },
    });
    if (!row) throw new NotFoundException('版本不存在');
    return row;
  }

  private async requireWriter(documentId: string, user: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id: documentId, deleted: false },
    });
    if (!doc) throw new NotFoundException('文档不存在');
    if (!canWriteDocument(doc, user)) {
      throw new ForbiddenException('只有作者或管理员可以查看版本');
    }
    return doc;
  }

  private async insertIgnore(snapshot: VersionSnapshot) {
    try {
      await this.em.save(
        this.em.create(DocumentVersionEntity, {
          id: nextSnowflakeId(),
          documentId: snapshot.documentId,
          version: snapshot.version,
          title: stripNullBytes(snapshot.title),
          content: stripNullBytes(snapshot.content),
          summary: snapshot.summary ? stripNullBytes(snapshot.summary) : null,
          createBy: snapshot.userId ?? null,
        }),
      );
    } catch (error) {
      const failed = error as { code?: string; driverError?: { code?: string } };
      if (failed.code === '23505' || failed.driverError?.code === '23505') return;
      throw error;
    }
  }
}
