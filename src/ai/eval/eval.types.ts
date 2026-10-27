import type { ChatIntent } from '../chat-query-rewrite.service';
import type { RetrieveEval } from '../agentic-retrieve';

/** 检索命中压缩后给评测用；不要把整段 chunk 送进 experiment 元数据。 */
export type ChatEvalHit = {
  documentId: string;
  documentTitle: string;
  heading: string | null;
  score: number;
  excerpt: string;
};

/**
 * 一轮非流式 chat 的评测快照。
 * HTTP `/ai/chat` 默认不返回；`includeEval: true` 时挂在 ChatResult.eval。
 */
export type ChatEvalSnapshot = {
  question: string;
  answer: string;
  intent: ChatIntent;
  allowRetrieve: boolean;
  allowGraph: boolean;
  allowWeb: boolean;
  graphQueries: string[];
  /** 实际发生过的动作，不是「允许挂工具」。 */
  retrieveCount: number;
  rewritten: boolean;
  retryQuery?: string;
  retrieveEval?: RetrieveEval;
  graphUsed: boolean;
  webUsed: boolean;
  /** rerank 后、切题过滤前 → Hit@K / Precision@K */
  rawHits: ChatEvalHit[];
  /** 喂给模型的切题 hits → false_hit / groundedness */
  gradedHits: ChatEvalHit[];
  webSnippet: string;
};

export type GoldenExpected = {
  intent: ChatIntent;
  requireRetrieve?: boolean;
  requireWeb?: boolean;
  forbidRetrieve?: boolean;
  forbidGraph?: boolean;
  forbidWeb?: boolean;
  expectRewrite?: boolean;
  /** 库空：必须承认没有且不编造（LLM judge，不是关键词） */
  expectRefusal?: boolean;
  /** 文档标题子串，如「差旅」。空数组 = 不应把任何文档当切题。 */
  relevantDocTitles?: string[];
  /** 语义要点，如「张敏」「加签」；由 completeness judge 判覆盖。 */
  keyPoints?: string[];
  /** 禁用事实，如「王芳」；由 completeness judge 判误含。 */
  mustNotContain?: string[];
  /** 默认 true；闲聊/纯联网关掉，避免无上下文空跑。 */
  judgeGroundedness?: boolean;
};

export type GoldenItem = {
  input: { question: string };
  expectedOutput: GoldenExpected;
  metadata: { id: string; suite: string };
};
