import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import { CategoryEntity } from './entities/category.entity';
import { DocumentEntity } from './entities/document.entity';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

export type CategoryNode = CategoryEntity & { children: CategoryNode[] };

@Injectable()
export class CategoryService {
  constructor(@InjectEntityManager() private readonly em: EntityManager) {}

  /** 未删除分类按 sort、创建时间组成树；parentId 为空或 0 视为根 */
  async tree(): Promise<CategoryNode[]> {
    const rows = await this.em.find(CategoryEntity, {
      where: { deleted: false },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
    const byParent = new Map<string, CategoryEntity[]>();
    for (const row of rows) {
      const key = row.parentId && row.parentId !== '0' ? row.parentId : '0';
      const list = byParent.get(key) ?? [];
      list.push(row);
      byParent.set(key, list);
    }
    const build = (parentId: string): CategoryNode[] =>
      (byParent.get(parentId) ?? []).map((row) => {
        const children = build(row.id);
        return children.length ? { ...row, children } : { ...row, children: [] };
      });
    return build('0');
  }

  /** 按 ID 批量取未删除分类名，返回 Map<id, name>；空 ID 忽略，已删或不存在的不出现 */
  async namesByIds(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.em
      .createQueryBuilder(CategoryEntity, 'cat')
      .where('cat.deleted = false')
      .andWhere('cat.id IN (:...ids)', { ids: unique })
      .getMany();
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** 分类必须存在且未删除，否则抛 BadRequestException */
  async assertActive(id: string) {
    const row = await this.em.findOne(CategoryEntity, {
      where: { id, deleted: false },
    });
    if (!row) throw new BadRequestException('分类不存在');
    return row;
  }

  /** 新建分类。未传 parentId 时挂到根（0） */
  async create(dto: CreateCategoryDto) {
    const parentId = await this.normalizeParent(dto.parentId);
    const row = this.em.create(CategoryEntity, {
      id: nextSnowflakeId(),
      name: dto.name.trim(),
      parentId,
      sort: dto.sort ?? 0,
      description: dto.description?.trim() || null,
      deleted: false,
    });
    return this.em.save(row);
  }

  /** 更新名称、排序、描述或父级。只改传入的字段 */
  async update(id: string, dto: UpdateCategoryDto) {
    const row = await this.assertActive(id);
    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.sort !== undefined) row.sort = dto.sort;
    if (dto.description !== undefined) {
      row.description = dto.description?.trim() || null;
    }
    if (dto.parentId !== undefined) {
      const parentId = await this.normalizeParent(dto.parentId, id);
      row.parentId = parentId;
    }
    return this.em.save(row);
  }

  /** 软删除。仍有子分类或未删除文档时拒绝 */
  async remove(id: string) {
    await this.assertActive(id);
    const child = await this.em.findOne(CategoryEntity, {
      where: { parentId: id, deleted: false },
    });
    if (child) throw new BadRequestException('请先删除子分类');
    const used = await this.em.count(DocumentEntity, {
      where: { categoryId: id, deleted: false },
    });
    if (used > 0) throw new BadRequestException('该分类下还有文档，不能删除');
    await this.em.update(CategoryEntity, { id }, { deleted: true });
    return { id };
  }

  /**
   * 规范化父级 ID：空值当成根 0。
   * 更新时禁止把自己或自己的子孙设为父级。
   */
  private async normalizeParent(parentId?: string | null, selfId?: string) {
    const next = parentId?.trim() || '0';
    if (next === '0') return '0';
    if (selfId && next === selfId) {
      throw new BadRequestException('不能把分类设为自己的子级');
    }
    await this.assertActive(next);
    if (selfId) {
      let cursor: string | null = next;
      const seen = new Set<string>();
      while (cursor && cursor !== '0') {
        if (cursor === selfId || seen.has(cursor)) {
          throw new BadRequestException('不能把分类移动到自己的子分类下');
        }
        seen.add(cursor);
        const parent: CategoryEntity | null = await this.em.findOne(
          CategoryEntity,
          {
            where: { id: cursor, deleted: false },
          },
        );
        cursor = parent?.parentId ?? null;
      }
    }
    return next;
  }
}
