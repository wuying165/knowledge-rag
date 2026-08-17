import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { ChunkingService } from './chunking.service';
import { ExtractionService } from './extraction.service';
import { PipelineDocument } from './types/pipeline.types';

/**
 * KG 知识图谱构建
 *
 * <p>图模型（简化）：</p>
 * <pre>
 * (KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
 * (KnowledgeEntity)-[:RELATED_TO]->(KnowledgeEntity)
 * </pre>
 *
 * <p>单篇构建步骤：</p>
 * <ol>
 *   <li>删除该文档旧图数据（clear before build）</li>
 *   <li>MERGE 文档节点</li>
 *   <li>ChunkingService 分块 → 每块建 DocumentChunk + HAS_CHUNK</li>
 *   <li>ExtractionService 抽实体关系 → MERGE 实体 / RELATED_TO / MENTIONS</li>
 * </ol>
 *
 * Neo4j 不可用时跳过写入（不抛错阻断发布消费）。
 */
@Injectable()
export class GraphBuildService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphBuildService.name);
  private driver: Driver | null = null;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly chunkingService: ChunkingService,
    private readonly extractionService: ExtractionService,
  ) {
    this.enabled = this.config.get<string>('NEO4J_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Neo4j 已禁用（NEO4J_ENABLED=false）');
      return;
    }
    const uri = this.config.get('NEO4J_URI', 'bolt://localhost:7687');
    const user = this.config.get('NEO4J_USER', 'neo4j');
    const password = this.config.get('NEO4J_PASSWORD', 'password');
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    try {
      await this.driver.verifyConnectivity();
      this.logger.log(`Neo4j 已连接：${uri}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j 不可用，KG 写入将跳过：${message}`);
      await this.driver.close();
      this.driver = null;
    }
  }

  async onModuleDestroy() {
    await this.driver?.close();
  }

  async buildForDocument(doc: PipelineDocument): Promise<number> {
    if (!this.driver) {
      this.logger.warn(`跳过 KG 构建（Neo4j 不可用）：documentId=${doc.id}`);
      return 0;
    }
    if (!doc.content?.trim()) {
      this.logger.log(`文档内容为空，跳过 KG：documentId=${doc.id}`);
      return 0;
    }

    await this.deleteForDocument(doc.id);

    const session = this.driver.session();
    const now = new Date().toISOString();
    try {
      await session.run(
        `
        MERGE (d:KnowledgeDocument {id: $id})
        SET d.title = $title, d.summary = $summary, d.categoryId = $categoryId,
            d.authorId = $authorId, d.status = $status, d.updatedAt = $now,
            d.createdAt = coalesce(d.createdAt, $now)
        `,
        {
          id: doc.id,
          title: doc.title,
          summary: doc.summary ?? '',
          categoryId: doc.categoryId ?? null,
          authorId: doc.authorId ?? null,
          status: doc.status,
          now,
        },
      );

      const chunks = await this.chunkingService.chunk({
        content: doc.content,
        documentId: doc.id,
        documentTitle: doc.title,
        categoryId: doc.categoryId,
        authorId: doc.authorId,
        teamId: doc.teamId,
        docStatus: doc.status,
        publishTime:
          doc.publishTime instanceof Date
            ? doc.publishTime.toISOString()
            : doc.publishTime
              ? new Date(doc.publishTime).toISOString()
              : null,
      });

      let totalEntities = 0;
      for (const chunk of chunks) {
        await session.run(
          `
          MERGE (c:DocumentChunk {chunkId: $chunkId})
          SET c.documentId = $documentId, c.content = $content, c.heading = $heading,
              c.chunkIndex = $chunkIndex, c.totalChunks = $totalChunks, c.updatedAt = $now
          WITH c
          MATCH (d:KnowledgeDocument {id: $documentId})
          MERGE (d)-[r:HAS_CHUNK]->(c)
          SET r.chunkIndex = $chunkIndex
          `,
          {
            chunkId: chunk.chunkId,
            documentId: doc.id,
            content: chunk.content,
            heading: chunk.heading ?? null,
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
            now,
          },
        );

        const extracted = await this.extractionService.extract(
          chunk.content,
          chunk.heading,
          doc.title,
        );
        extracted.chunkId = chunk.chunkId;
        const written = await this.writeExtraction(session, extracted);
        totalEntities += written;
      }

      this.logger.log(
        `KG 图谱构建完成：documentId=${doc.id}, chunks=${chunks.length}, entities=${totalEntities}`,
      );
      return totalEntities;
    } finally {
      await session.close();
    }
  }

  async buildBatch(docs: PipelineDocument[]) {
    for (const doc of docs) {
      try {
        await this.buildForDocument(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`KG 构建失败：documentId=${doc.id}, ${message}`);
      }
    }
  }

  async deleteForDocument(documentId: string) {
    if (!this.driver) return;
    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (d:KnowledgeDocument {id: $id})
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)
        DETACH DELETE c, d
        `,
        { id: documentId },
      );
      await session.run(
        `
        MATCH (e:KnowledgeEntity)
        WHERE NOT (e)<-[:MENTIONS]-()
        DETACH DELETE e
        `,
      );
      this.logger.log(`KG 图谱已删除：documentId=${documentId}`);
    } finally {
      await session.close();
    }
  }

  private async writeExtraction(
    session: Session,
    result: {
      chunkId?: string;
      entities: Array<{
        name: string;
        type: string;
        description?: string;
        aliases?: string[];
      }>;
      relations: Array<{
        source: string;
        target: string;
        relation: string;
        weight?: number;
      }>;
    },
  ): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;

    for (const entity of result.entities) {
      await session.run(
        `
        MERGE (e:KnowledgeEntity {name: $name})
        ON CREATE SET e.type = $type, e.description = $description,
                      e.aliases = $aliases, e.createdAt = $now, e.updatedAt = $now
        ON MATCH SET e.type = coalesce($type, e.type),
                     e.description = CASE WHEN $description <> '' THEN $description ELSE e.description END,
                     e.updatedAt = $now
        `,
        {
          name: entity.name,
          type: entity.type,
          description: entity.description ?? '',
          aliases: entity.aliases ?? [],
          now,
        },
      );
      count++;

      if (result.chunkId) {
        await session.run(
          `
          MATCH (c:DocumentChunk {chunkId: $chunkId})
          MATCH (e:KnowledgeEntity {name: $name})
          MERGE (c)-[:MENTIONS]->(e)
          `,
          { chunkId: result.chunkId, name: entity.name },
        );
      }
    }

    for (const rel of result.relations) {
      await session.run(
        `
        MATCH (a:KnowledgeEntity {name: $source})
        MATCH (b:KnowledgeEntity {name: $target})
        MERGE (a)-[r:RELATED_TO]->(b)
        ON CREATE SET r.relation = $relType, r.weight = $weight, r.createdAt = datetime()
        ON MATCH SET r.weight = coalesce($weight, r.weight)
        `,
        {
          source: rel.source,
          target: rel.target,
          relType: rel.relation,
          weight: rel.weight ?? 0.5,
        },
      );
    }

    return count;
  }
}
