import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type {
  ChatEvalHit,
  ChatEvalSnapshot,
  GoldenExpected,
} from './eval.types';

/** Langfuse score：value=null 表示本题跳过，不会写入 experiment。 */
export type EvalScore = {
  name: string;
  value: number | null;
  comment?: string;
};

type EvalArgs = {
  input: { question: string };
  output: ChatEvalSnapshot;
  expectedOutput?: GoldenExpected;
};

function titlesOf(hits: ChatEvalHit[]): string[] {
  return hits.map((h) => h.documentTitle);
}

/** 金标是标题子串（「差旅」），不是自由表述；双向 includes 避免标题长短不一。 */
function matchesGold(title: string, gold: string): boolean {
  return title.includes(gold) || gold.includes(title);
}

function hitMatchesGold(hits: ChatEvalHit[], gold: string[]): boolean {
  if (!gold.length) return false;
  return hits.some((h) => gold.some((g) => matchesGold(h.documentTitle, g)));
}

function formatKbContext(output: ChatEvalSnapshot): string {
  if (!output.gradedHits.length) return '（无知识库切题资料）';
  return output.gradedHits
    .map(
      (h, i) =>
        `[${i + 1}] ${h.documentTitle}${h.heading ? ` / ${h.heading}` : ''}\n${h.excerpt}`,
    )
    .join('\n\n');
}

/** 路由：实际 intent 是否等于金标。 */
export async function intentMatch({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const expected = expectedOutput?.intent;
  if (!expected) {
    return { name: 'intent_match', value: null, comment: '无期望意图' };
  }
  const ok = output.intent === expected;
  return {
    name: 'intent_match',
    value: ok ? 1 : 0,
    comment: ok
      ? `intent=${output.intent}`
      : `期望 ${expected}，实际 ${output.intent}`,
  };
}

/** 护栏：按意图约束实际有没有 retrieve / graph / web，不看文案。 */
export async function toolPolicy({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const exp = expectedOutput;
  if (!exp) return { name: 'tool_policy', value: null, comment: '无期望' };
  const fails: string[] = [];
  if (exp.forbidRetrieve && output.retrieveCount > 0) {
    fails.push(`禁止检索但 retrieveCount=${output.retrieveCount}`);
  }
  if (exp.forbidGraph && output.graphUsed) fails.push('禁止图谱但调用了');
  if (exp.forbidWeb && output.webUsed) fails.push('禁止联网但调用了');
  if (exp.requireRetrieve && output.retrieveCount < 1) {
    fails.push('应检索但未检索');
  }
  if (exp.requireWeb && !output.webUsed) fails.push('应联网但未联网');
  const ok = fails.length === 0;
  return {
    name: 'tool_policy',
    value: ok ? 1 : 0,
    comment: ok ? '工具策略符合意图' : fails.join('；'),
  };
}

/** 沾边题：首轮不足后必须改写出不同检索词再查。 */
export async function rewriteLoop({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  if (!expectedOutput?.expectRewrite) {
    return { name: 'rewrite_loop', value: null, comment: '本题不要求改写' };
  }
  const ok = Boolean(
    output.rewritten &&
      output.retryQuery &&
      output.retryQuery !== output.retrieveEval?.query,
  );
  return {
    name: 'rewrite_loop',
    value: ok ? 1 : 0,
    comment: ok
      ? `改写 ${output.retrieveEval?.query} → ${output.retryQuery}`
      : `未改写再查 retried=${output.retrieveEval?.retried ?? false}`,
  };
}

const refusalSchema = z.object({
  refused: z.boolean().describe('是否明确表示知识库没有、无法回答或资料不足'),
  fabricated: z
    .boolean()
    .describe('是否编造了制度、流程、负责人、材料清单等内部事实'),
  comment: z.string(),
});

/**
 * 库空题：必须承认没有，且不能编造。
 * 不用关键词：模型会说「未收录 / 查不到对应制度 / 没有相关 SOP」等，正则极易漏或误伤。
 */
export async function refusalQuality({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  if (!expectedOutput?.expectRefusal) {
    return { name: 'refusal_quality', value: null, comment: '本题不要求拒答' };
  }
  const judged = await invokeJudge(
    refusalSchema,
    '你评估企业知识库助手在「库里没有」场景下的表现。' +
      'refused=true：清楚表示没有依据/未找到/无法回答，而不是用闲聊带过。' +
      'fabricated=true：捏造了制度、流程、材料、负责人或内部规定。' +
      '礼貌收尾不算编造。',
    `用户问题：${output.question}\n\n助手回答：${output.answer}\n\n检索评估：${output.retrieveEval?.reason ?? '-'}\n切题资料条数：${output.gradedHits.length}`,
  );
  if (!judged.ok) {
    return { name: 'refusal_quality', value: null, comment: judged.error };
  }
  const { refused, fabricated, comment } = judged.data;
  const ok = refused && !fabricated;
  return {
    name: 'refusal_quality',
    value: ok ? 1 : 0,
    comment: `${refused ? '已拒答' : '未拒答'}${fabricated ? '，且编造' : ''}：${comment}`,
  };
}

/** 检索层：rerank 后 Top-5 是否出现金标文档（grade 过滤前）。 */
export async function hitAt5({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  if (!gold?.length) {
    return { name: 'hit_at_5', value: null, comment: '无相关文档金标' };
  }
  const top = output.rawHits.slice(0, 5);
  const ok = hitMatchesGold(top, gold);
  return {
    name: 'hit_at_5',
    value: ok ? 1 : 0,
    comment: ok
      ? `命中 ${titlesOf(top).join(' / ')}`
      : `Top5=${titlesOf(top).join(' / ') || '空'}`,
  };
}

/** 检索层：Top-5 里标题能对上金标的比例。 */
export async function precisionAt5({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  if (!gold?.length) {
    return { name: 'precision_at_5', value: null, comment: '无相关文档金标' };
  }
  const top = output.rawHits.slice(0, 5);
  if (!top.length) {
    return { name: 'precision_at_5', value: 0, comment: '无召回' };
  }
  const relevant = top.filter((h) =>
    gold.some((g) => matchesGold(h.documentTitle, g)),
  ).length;
  return {
    name: 'precision_at_5',
    value: relevant / top.length,
    comment: `相关 ${relevant}/${top.length}`,
  };
}

/**
 * 空金标（库空/沾边题）：grader 仍把资料标切题并喂给模型，算误命中。
 * 只看 gradedHits，不看 rawHits——检索到差旅但评估为不切题是正确行为。
 */
export async function falseHit({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  const emptyGold = Array.isArray(gold) && gold.length === 0;
  if (!emptyGold) {
    return { name: 'false_hit', value: null, comment: '非空检索题' };
  }
  const leaked = output.gradedHits.length > 0;
  return {
    name: 'false_hit',
    value: leaked ? 0 : 1,
    comment: leaked
      ? `误把 ${titlesOf(output.gradedHits).join(' / ')} 当切题`
      : '未把不相关资料喂给模型',
  };
}

const completenessSchema = z.object({
  covered: z.array(z.string()).describe('回答里已经覆盖的要点（从给定列表里选）'),
  missing: z.array(z.string()).describe('回答里缺失的要点'),
  forbiddenHit: z
    .array(z.string())
    .describe('回答里出现的禁用事实（从给定列表里选）'),
  comment: z.string(),
});

/**
 * 生成层要点覆盖。人名/岗位这类金标用语义判断，避免「张敏」写成「财务张敏老师」就判 0。
 * 张冠李戴（李明 vs 王芳）放 forbiddenHit，由 judge 对照列表，不靠裸正则扫全文。
 */
export async function completeness({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const points = expectedOutput?.keyPoints ?? [];
  const forbidden = expectedOutput?.mustNotContain ?? [];
  if (!points.length && !forbidden.length) {
    return { name: 'completeness', value: null, comment: '无要点金标' };
  }
  const judged = await invokeJudge(
    completenessSchema,
    '你评估回答是否覆盖给定要点、是否误含禁用事实。' +
      '要点只要语义等价即可（如「找张敏加签」覆盖「张敏」「加签」）。' +
      'covered/missing/forbiddenHit 只能出自用户给出的列表，不要发明新条目。',
    `用户问题：${output.question}\n\n助手回答：${output.answer}\n\n要点：${points.join('、') || '无'}\n禁用：${forbidden.join('、') || '无'}`,
  );
  if (!judged.ok) {
    return { name: 'completeness', value: null, comment: judged.error };
  }
  const { covered, missing, forbiddenHit, comment } = judged.data;
  if (forbiddenHit.length) {
    return {
      name: 'completeness',
      value: 0,
      comment: `误含：${forbiddenHit.join('、')}。${comment}`,
    };
  }
  if (!points.length) {
    return { name: 'completeness', value: 1, comment };
  }
  const uniqueHit = points.filter((p) => covered.includes(p));
  const miss =
    missing.filter((p) => points.includes(p)).length > 0
      ? missing.filter((p) => points.includes(p))
      : points.filter((p) => !uniqueHit.includes(p));
  return {
    name: 'completeness',
    value: uniqueHit.length / points.length,
    comment: `覆盖 ${uniqueHit.length}/${points.length}${miss.length ? `，缺 ${miss.join('、')}` : ''}。${comment}`,
  };
}

const groundednessSchema = z.object({
  verdict: z.enum(['supported', 'mixed', 'fabricated']),
  comment: z.string(),
});

/**
 * 生成层忠实度：制度性断言必须能被本轮切题资料或联网摘录支撑。
 * 承认没有不算编造。闲聊题通过 judgeGroundedness=false 跳过。
 */
export async function groundedness({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  if (expectedOutput?.judgeGroundedness === false) {
    return { name: 'groundedness', value: null, comment: '本题不跑忠实度' };
  }
  const judged = await invokeJudge(
    groundednessSchema,
    '你评估企业知识库助手的忠实度。制度性断言必须能被检索资料或联网摘录支撑。' +
      '承认没有、闲聊、不涉及制度的句子不算编造。' +
      'supported=全部制度断言有依据；mixed=部分无依据；fabricated=编造了制度/负责人/电话/流程。',
    `用户问题：${output.question}\n\n助手回答：${output.answer}\n\n知识库资料：\n${formatKbContext(output)}\n\n联网：\n${output.webSnippet || '（无联网结果）'}`,
  );
  if (!judged.ok) {
    return { name: 'groundedness', value: null, comment: judged.error };
  }
  const { verdict, comment } = judged.data;
  const value =
    verdict === 'supported' ? 1 : verdict === 'mixed' ? 0.5 : 0;
  return {
    name: 'groundedness',
    value,
    comment: `${verdict}：${comment}`,
  };
}

type JudgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

let judgeLlm: ChatOpenAI | undefined;
let judgeLlmReady = false;

function getJudgeLlm(): ChatOpenAI | undefined {
  if (judgeLlmReady) return judgeLlm;
  judgeLlmReady = true;
  const apiKey =
    process.env.OPENAI_API_KEY ||
    process.env.LLM_API_KEY ||
    process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return undefined;
  judgeLlm = new ChatOpenAI({
    apiKey,
    model:
      process.env.EVAL_JUDGE_MODEL ||
      process.env.MODEL_NAME ||
      process.env.LLM_MODEL ||
      'qwen-plus',
    temperature: 0,
    timeout: Number(process.env.AI_QUERY_REWRITE_TIMEOUT_MS ?? 20000),
    maxRetries: 0,
    useResponsesApi: false,
    configuration: {
      baseURL:
        process.env.OPENAI_BASE_URL ||
        process.env.LLM_BASE_URL ||
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
  });
  return judgeLlm;
}

async function invokeJudge<T extends z.ZodType>(
  schema: T,
  system: string,
  user: string,
): Promise<JudgeResult<z.infer<T>>> {
  const llm = getJudgeLlm();
  if (!llm) return { ok: false, error: '未配置评测模型' };
  try {
    const data = await llm.withStructuredOutput(schema).invoke([
      new SystemMessage(system),
      new HumanMessage(user),
    ]);
    return { ok: true, data: data as z.infer<T> };
  } catch (error) {
    return {
      ok: false,
      error: `judge 失败：${error instanceof Error ? error.message : error}`,
    };
  }
}

type EvaluatorFn = (args: EvalArgs) => Promise<EvalScore>;

/** value=null 的分数不写入 Langfuse，避免把「跳过」当成 0 分。 */
function toLangfuseEvaluator(fn: EvaluatorFn) {
  return async (args: {
    input: { question: string };
    output: ChatEvalSnapshot;
    expectedOutput?: GoldenExpected;
  }) => {
    const score = await fn(args);
    if (score.value == null) return [];
    return {
      name: score.name,
      value: score.value,
      comment: score.comment,
    };
  };
}

export const AGENT_EVALUATORS = [
  intentMatch,
  toolPolicy,
  rewriteLoop,
  refusalQuality,
  hitAt5,
  precisionAt5,
  falseHit,
  completeness,
  groundedness,
].map(toLangfuseEvaluator);
