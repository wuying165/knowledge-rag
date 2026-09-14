import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { HybridRetrievalService } from './hybrid-retrieval.service';
import { ChunkHit } from '../pipeline/types/pipeline.types';
import { ChatSessionService } from './chat-session.service';
import { ChatShortMemoryService } from './chat-short-memory.service';
import { ChatLongMemoryService } from './chat-long-memory.service';
import { ChatQueryRewriteService } from './chat-query-rewrite.service';
import { dbRowsToMessages } from './chat-memory.util';
import type { AuthUser } from '../auth/auth-user.interface';
import type { ChatSource } from './chat.types';

export type { ChatSource } from './chat.types';

const EXCERPT_LEN = 200;
const CITATION_RE = /\[(\d+)\]/g;

/**
 * RAG 对话：kh_chunk 混合检索（关键词 + 向量 + RRF + rerank）→ LLM 作答。
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly llm?: ChatOpenAI;

  constructor(
    config: ConfigService,
    private readonly retrieval: HybridRetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly shortMemory: ChatShortMemoryService,
    private readonly longMemory: ChatLongMemoryService,
    private readonly queryRewrite: ChatQueryRewriteService,
  ) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      undefined;
    if (!apiKey) {
      return;
    }

    const baseUrl =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const model =
      config.get<string>('MODEL_NAME') ||
      config.get<string>('LLM_MODEL') ||
      'qwen-plus';

    this.llm = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL: baseUrl },
    });
  }

  async chat(
    question: string,
    topK = 5,
    user?: AuthUser,
    sessionId?: string,
  ) {
    const trimmed = question.trim();
    if (!trimmed) {
      return {
        sessionId: sessionId ?? null,
        answer: '请输入问题。',
        sources: [] as ChatSource[],
      };
    }

    const history = user
      ? await this.loadWorkingHistory(user.userId, sessionId)
      : [];
    const plan = await this.queryRewrite.rewrite(trimmed, history);
    const [hits, memHits] = await Promise.all([
      plan.needRetrieve
        ? this.retrieval.retrieve(plan.query, topK, user)
        : Promise.resolve([] as ChunkHit[]),
      user
        ? this.longMemory.search(user.userId, sessionId, plan.query)
        : Promise.resolve({ user: [] as string[], session: [] as string[] }),
    ]);
    if (plan.needRetrieve && !hits.length) {
      const empty = {
        answer: '知识库里没有相关内容。',
        sources: [] as ChatSource[],
      };
      const session = user
        ? await this.sessions.appendTurn(
            user.userId,
            sessionId,
            trimmed,
            empty.answer,
            empty.sources,
          )
        : null;
      if (user && session) {
        await this.shortMemory.appendTurn(
          user.userId,
          session.id,
          history,
          trimmed,
          empty.answer,
        );
        this.longMemory.rememberTurn(
          user.userId,
          session.id,
          trimmed,
          empty.answer,
        );
      }
      return { sessionId: session?.id ?? sessionId ?? null, ...empty };
    }

    if (!this.llm) {
      throw new ServiceUnavailableException(
        '未配置 OPENAI_API_KEY / LLM_API_KEY / DASHSCOPE_API_KEY，无法生成回答',
      );
    }

    const memoryMsg = this.longMemory.buildSystemMessage(memHits);
    const userTurn = hits.length
      ? `检索到的资料：\n${this.buildContext(hits)}\n\n用户问题：${trimmed}`
      : `用户问题：${trimmed}`;
    const response = await this.llm.invoke([
      new SystemMessage(
        '你是企业知识库助手。有检索资料时只根据资料回答用户问题。' +
          '结合对话历史和记忆里的用户背景，但制度/流程以本轮资料为准，不要用记忆替代文档。' +
          '没有检索资料时，可回应寒暄或对话，不要编造制度。' +
          '若资料不足以回答制度问题，明确说不知道，不要编造。' +
          '凡是依据某条资料作出的陈述，必须在句末标注对应编号，如 [1]、[2]。' +
          '编号必须与资料列表一致，不要标注未使用的编号，不要编造文档标题或链接。' +
          '回答简洁，必要时列出条目。',
      ),
      ...(memoryMsg ? [memoryMsg] : []),
      ...history,
      new HumanMessage(userTurn),
    ]);

    const answer =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    const sources = this.toCitedSources(answer, hits);
    this.logger.log(
      `RAG 对话完成：hits=${hits.length}, cited=${sources.length}, answerLength=${answer.length}`,
    );

    const session = user
      ? await this.sessions.appendTurn(
          user.userId,
          sessionId,
          trimmed,
          answer,
          sources,
        )
      : null;

    if (user && session) {
      await this.shortMemory.appendTurn(
        user.userId,
        session.id,
        history,
        trimmed,
        answer,
      );
      void this.longMemory.rememberTurn(
        user.userId,
        session.id,
        trimmed,
        answer,
      );
    }

    return { sessionId: session?.id ?? sessionId ?? null, answer, sources };
  }

  private async loadWorkingHistory(
    userId: string,
    sessionId: string | undefined,
  ): Promise<BaseMessage[]> {
    if (!sessionId) return [];
    const cached = await this.shortMemory.tryLoad(userId, sessionId);
    if (cached) return cached;
    const rows = await this.sessions.listRecentMessages(
      userId,
      sessionId,
      this.shortMemory.windowSize,
    );
    const history = dbRowsToMessages(rows);
    if (history.length) {
      await this.shortMemory.save(userId, sessionId, history);
    }
    return history;
  }

  /** 从回答中抽出 [n]，只返回实际引用的资料；未标注时回退为全部召回（摘录）。 */
  private toCitedSources(answer: string, hits: ChunkHit[]): ChatSource[] {
    const cited = new Set<number>();
    for (const match of answer.matchAll(CITATION_RE)) {
      const n = Number(match[1]);
      if (n >= 1 && n <= hits.length) cited.add(n);
    }

    const indexes =
      cited.size > 0 ? [...cited].sort((a, b) => a - b) : hits.map((_, i) => i + 1);

    return indexes.map((index) => this.toSource(index, hits[index - 1]));
  }

  private toSource(index: number, hit: ChunkHit): ChatSource {
    return {
      index,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      heading: hit.heading,
      excerpt: this.excerpt(hit.content),
      score: hit.score,
    };
  }

  private excerpt(content: string): string {
    const text = content.replace(/\s+/g, ' ').trim();
    if (text.length <= EXCERPT_LEN) return text;
    return `${text.slice(0, EXCERPT_LEN)}...`;
  }

  private buildContext(hits: ChunkHit[]): string {
    return hits
      .map((src, i) => {
        const heading = src.heading ? ` / ${src.heading}` : '';
        const snippet =
          src.content.length > 800
            ? `${src.content.slice(0, 800)}...`
            : src.content;
        return `[${i + 1}] ${src.documentTitle}${heading}\n${snippet}`;
      })
      .join('\n\n');
  }
}
