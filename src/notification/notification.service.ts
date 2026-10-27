import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import { UserEntity } from '../user/entities/user.entity';
import { NotificationEntity } from './notification.entity';
import { BroadcastNotificationDto } from './notification.dto';

export type NotifyInput = {
  userId: string;
  type: 'like' | 'comment' | 'system';
  title: string;
  content?: string | null;
  documentId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
};

@Injectable()
export class NotificationService {
  constructor(@InjectEntityManager() private readonly em: EntityManager) {}

  async notify(input: NotifyInput) {
    if (!input.userId) return null;
    return this.em.save(
      this.em.create(NotificationEntity, {
        id: nextSnowflakeId(),
        userId: input.userId,
        type: input.type,
        title: input.title.slice(0, 100),
        content: input.content?.slice(0, 2000) ?? null,
        documentId: input.documentId ?? null,
        senderId: input.senderId ?? null,
        senderName: input.senderName?.slice(0, 50) ?? null,
        isRead: false,
      }),
    );
  }

  async list(userId: string, page = 1, pageSize = 20) {
    const [items, total] = await this.em.findAndCount(NotificationEntity, {
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  async unreadCount(userId: string) {
    const count = await this.em.count(NotificationEntity, {
      where: { userId, isRead: false },
    });
    return { count };
  }

  async markRead(userId: string, id: string) {
    const row = await this.em.findOne(NotificationEntity, { where: { id, userId } });
    if (!row) throw new NotFoundException('通知不存在');
    if (!row.isRead) {
      row.isRead = true;
      await this.em.save(row);
    }
    return row;
  }

  async markAllRead(userId: string) {
    await this.em.update(
      NotificationEntity,
      { userId, isRead: false },
      { isRead: true },
    );
    return { ok: true };
  }

  async broadcast(dto: BroadcastNotificationDto, sender: { userId: string; name: string }) {
    const title = dto.title.trim();
    const content = dto.content.trim();
    if (!title || !content) throw new BadRequestException('标题和内容不能为空');

    let users: UserEntity[];
    if (dto.userIds?.length) {
      users = await this.em.find(UserEntity, {
        where: { id: In(dto.userIds), deleted: false, status: 1 },
      });
      if (!users.length) throw new BadRequestException('没有可接收的用户');
    } else {
      users = await this.em.find(UserEntity, {
        where: { deleted: false, status: 1 },
      });
    }

    const rows = users.map((user) =>
      this.em.create(NotificationEntity, {
        id: nextSnowflakeId(),
        userId: user.id,
        type: 'system',
        title: title.slice(0, 100),
        content: content.slice(0, 2000),
        documentId: null,
        senderId: sender.userId,
        senderName: sender.name.slice(0, 50),
        isRead: false,
      }),
    );
    if (rows.length) await this.em.save(rows);
    return { count: rows.length };
  }
}
