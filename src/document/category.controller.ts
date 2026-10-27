import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { CategoryService } from './category.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PermissionCode } from '../common/constants/permissions';

@Controller('categories')
export class CategoryController {
  constructor(private readonly categories: CategoryService) {}

  /** 分类树。有文档列表权限即可用于筛选和下拉。 */
  @Get('tree')
  @RequirePermission(
    PermissionCode.documentList,
    PermissionCode.documentCategoryQuery,
  )
  tree() {
    return this.categories.tree();
  }

  @Post()
  @RequirePermission(PermissionCode.documentCategory)
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Put(':id')
  @RequirePermission(PermissionCode.documentCategory)
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission(PermissionCode.documentCategory)
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
