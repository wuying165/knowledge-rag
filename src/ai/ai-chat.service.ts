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
import { ChatQueryRewriteService, type ChatIntent } from './chat-query-rewrite.service';
import { retrieveUntilRelevant } from './agentic-retrieve';
import { WebSearchService, type WebSearchResult } from './web-search.service';
import {
  formatGraphSystemText,
  GraphBuildService,
} from '../pipeline/graph-build.service';
import { accessFromUser } from '../document/document-access';
import { dbRowsToMessages } from './chat-memory.util';
import type { AuthUser } from '../auth/auth-user.interface';
import type { ChatSource } from './chat.types';
import type { ChatEvalHit, ChatEvalSnapshot } from './eval/eval.types';
import { withObservation, withTraceAttrs } from '../observability/langfuse';

export type { ChatSource } from './chat.types';

export type ChatOptions = {
  /** 默认 true：写入会话与记忆。评测脚本关。 */
  persist?: boolean;
  /** 附带评测快照 */
  includeEval?: boolean;
};

export type ChatResult = {
  sessionId: string | null;
  answer: string;
  sources: ChatSource[];
  eval?: ChatEvalSnapshot;
};

const EXCERPT_LEN = 200; // 引用摘录截断长度（字符）
const CITATION_RE = /\[(\d+)\]/g; // 回答里的 [1]、[2] 引用编号

/**
 * 非流式 Agentic RAG：意图路由 → 知识库与图谱并行检索（不足则改写再查）→ 按需联网 → 作答。
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
    private readonly webSearch: WebSearchService,
    private readonly graph: GraphBuildService,
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
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const persist = options?.persist !== false;
    const includeEval = Boolean(options?.includeEval);
    const trimmed = question.trim();
    if (!trimmed) {
      return {
        sessionId: sessionId ?? null,
        answer: '请输入问题。',
        sources: [] as ChatSource[],
      };
    }

    return withObservation('ai-chat', (update) =>
      withTraceAttrs(
        {
          userId: user?.userId,
          sessionId,
          tags: ['ai-chat', 'agentic-rag'],
        },
        () =>
          this.runChatTurn({
            trimmed,
            topK,
            user,
            sessionId,
            persist,
            includeEval,
            update,
          }),
      ),
    );
  }

  private async runChatTurn(opts: {
    trimmed: string;
    topK: number;
    user?: AuthUser;
    sessionId?: string;
    persist: boolean;
    includeEval: boolean;
    update: (fields: Record<string, unknown>) => void;
  }): Promise<ChatResult> {
    const { trimmed, topK, user, sessionId, persist, includeEval, update } = opts;
    const history = user
      ? await this.loadWorkingHistory(user.userId, sessionId)
      : [];
    const plan = await this.queryRewrite.classify(trimmed, history);
    const memHitsP = user
      ? this.longMemory.search(user.userId, sessionId, plan.query)
      : Promise.resolve({ user: [] as string[], session: [] as string[] });
    // 图谱与知识库同一层：意图确定后再并行检索，不和 classify 抢跑。
    const access = user ? accessFromUser(user) : undefined;
    const kbP = plan.allowRetrieve
      ? retrieveUntilRelevant({
          question: trimmed,
          query: plan.query,
          topK,
          user,
          retrieval: this.retrieval,
          rewrite: this.queryRewrite,
        })
      : Promise.resolve(undefined);
    const graphP =
      plan.allowGraph && user && access && plan.graphQueries.length
        ? this.graph.retrieveForChat(plan.graphQueries, 8, access)
        : Promise.resolve(undefined);
    const [retrieved, graphHit] = await Promise.all([kbP, graphP]);
    let hits = [] as ChunkHit[];
    let kbInsufficient = false;
    let searchQuery = plan.query || trimmed;
    if (retrieved) {
      hits = retrieved.hits;
      kbInsufficient = !retrieved.eval.ok;
      searchQuery = retrieved.usedQuery || searchQuery;
    }
    const hasGraph = Boolean(
      graphHit?.entities.length || graphHit?.relations.length,
    );
    const web =
      plan.allowWeb && (!plan.allowRetrieve || kbInsufficient)
        ? await this.webSearch.search(searchQuery)
        : undefined;
    const memHits = await memHitsP;

    const snapshot = (answer: string): ChatEvalSnapshot => ({
      question: trimmed,
      answer,
      intent: plan.intent,
      allowRetrieve: plan.allowRetrieve,
      allowGraph: plan.allowGraph,
      allowWeb: plan.allowWeb,
      graphQueries: plan.graphQueries,
      retrieveCount: retrieved?.retrieveCount ?? 0,
      rewritten: Boolean(retrieved?.eval.retried),
      retryQuery: retrieved?.eval.retryQuery,
      retrieveEval: retrieved?.eval,
      graphUsed: Boolean(graphHit),
      webUsed: Boolean(web),
      rawHits: (retrieved?.rawHits ?? []).map(toEvalHit),
      gradedHits: hits.map(toEvalHit),
      webSnippet: web
        ? web.error ||
          web.items.map((i) => `${i.title}\n${i.url}\n${i.snippet}`).join('\n')
        : '',
    });

    const finish = (
      answer: string,
      sources: ChatSource[],
      sid: string | null,
    ): ChatResult => {
      const evalSnap = snapshot(answer);
      update({
        input: { question: trimmed },
        output: { answer, intent: plan.intent, eval: retrieved?.eval },
        metadata: {
          intent: plan.intent,
          retrieveCount: evalSnap.retrieveCount,
          hitTitles: evalSnap.rawHits.map((h) => h.documentTitle),
        },
      });
      return {
        sessionId: sid,
        answer,
        sources,
        ...(includeEval ? { eval: evalSnap } : {}),
      };
    };

    if (plan.intent === 'kb' && kbInsufficient && !hasGraph) {
      const empty = {
        answer: '知识库里没有相关内容。',
        sources: [] as ChatSource[],
      };
      const session = persist && user
        ? await this.sessions.appendTurn(
            user.userId,
            sessionId,
            trimmed,
            empty.answer,
            empty.sources,
          )
        : null;
      if (persist && user && session) {
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
      return finish(
        empty.answer,
        empty.sources,
        session?.id ?? sessionId ?? null,
      );
    }

    if (!this.llm) {
      throw new ServiceUnavailableException(
        '未配置 OPENAI_API_KEY / LLM_API_KEY / DASHSCOPE_API_KEY，无法生成回答',
      );
    }

    const memoryMsg = this.longMemory.buildSystemMessage(memHits);
    const graphMsg = graphHit ? formatGraphSystemText(graphHit) : '';
    const parts: string[] = [];
    if (hits.length) parts.push(`知识库资料：\n${this.buildContext(hits)}`);
    if (web) parts.push(`联网结果：\n${this.buildWebContext(web)}`);
    parts.push(`用户问题：${trimmed}`);
    const userTurn = parts.join('\n\n');
    const response = await this.llm.invoke([
      new SystemMessage(
        this.buildSystemPrompt(plan.intent, Boolean(hits.length), web),
      ),
      ...(memoryMsg ? [memoryMsg] : []),
      ...(graphMsg ? [new SystemMessage(graphMsg)] : []),
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

    const session = persist && user
      ? await this.sessions.appendTurn(
          user.userId,
          sessionId,
          trimmed,
          answer,
          sources,
        )
      : null;

    if (persist && user && session) {
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

    return finish(answer, sources, session?.id ?? sessionId ?? null);
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
        return `[${i + 1}] ${src.documentTitle}${heading}\n${src.content}`;
      })
      .join('\n\n');
  }

  private buildWebContext(web: WebSearchResult): string {
    if (web.error) return web.error;
    if (!web.items.length) return '无结果。';
    return web.items
      .map((hit, i) => `${i + 1}. ${hit.title}\n${hit.url}\n${hit.snippet}`)
      .join('\n\n');
  }

  private buildSystemPrompt(
    intent: ChatIntent,
    hasKb: boolean,
    web?: WebSearchResult,
  ): string {
    let prompt =
      '你是企业知识库助手。结合对话历史和记忆里的用户背景回答。' +
      '制度/流程以本轮知识库资料为准，不要用记忆替代文档。';
    if (hasKb) {
      prompt +=
        '凡是依据某条资料作出的陈述，必须在句末标注对应编号，如 [1]、[2]。' +
        '编号必须与资料列表一致，不要标注未使用的编号，不要编造文档标题或链接。';
    } else if (intent === 'kb' || intent === 'kb_then_web') {
      prompt += '知识库没有切题资料，不要编造内部制度。';
    }
    if (web?.items.length) {
      prompt += '联网结果只作公开信息补充，用标题+链接说明，不要写成公司内部规定。';
    }
    if (intent === 'chitchat' || intent === 'profile') {
      prompt += '可回应寒暄或个人偏好，不要编造制度。';
    }
    prompt += '若资料不足以回答，明确说不知道。回答简洁，必要时列出条目。';
    return prompt;
  }
}

function toEvalHit(hit: ChunkHit): ChatEvalHit {
  const text = hit.content.replace(/\s+/g, ' ').trim();
  return {
    documentId: hit.documentId,
    documentTitle: hit.documentTitle,
    heading: hit.heading,
    score: hit.score,
    excerpt: text.length > 400 ? `${text.slice(0, 400)}...` : text,
  };
}

