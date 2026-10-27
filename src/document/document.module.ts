import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentService } from './document.service';
import { DocumentReviewService } from './document-review.service';
import { DocumentController } from './document.controller';
import {
  DocumentContent,
  DocumentContentSchema,
} from './schemas/document-content.schema';
import { FileParserService } from './parser/file-parser.service';
import { MineruParser } from './parser/mineru.parser';
import { PipelineModule } from '../pipeline/pipeline.module';
import { NotificationModule } from '../notification/notification.module';
import { CategoryService } from './category.service';
import { CategoryController } from './category.controller';
import { DocumentSocialService } from './document-social.service';
import { DocumentShareService } from './document-share.service';
import { DocumentVersionService } from './document-version.service';
import { ShareController } from './share.controller';
import {
  DocumentEngagementController,
  FavoriteController,
} from './document-engagement.controller';

/**
 * 文档模块
 * - DocumentService：文档 CRUD + 状态流转（草稿 / 发布 / 归档 / 待审核）
 * - DocumentReviewService：发布审核（提交 / 通过 / 驳回）
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
    PipelineModule,
    NotificationModule,
  ],
  controllers: [
    DocumentController,
    CategoryController,
    ShareController,
    DocumentEngagementController,
    FavoriteController,
  ],
  providers: [
    DocumentService,
    DocumentReviewService,
    FileParserService,
    MineruParser,
    CategoryService,
    DocumentSocialService,
    DocumentShareService,
    DocumentVersionService,
  ],
  exports: [DocumentService, DocumentReviewService, FileParserService],
})
export class DocumentModule {}
