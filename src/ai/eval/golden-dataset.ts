import type { GoldenItem } from './eval.types';

/**
 * 与 agentic-rag.md 对齐的离线集。
 *
 * relevantDocTitles 用标题子串而不是 documentId：本地/CI 文档 ID 会变。
 * 空数组表示「库里没有对应制度」，用来算 false_hit，不要省略该字段。
 * keyPoints / mustNotContain 交给 completeness 的 LLM judge，不要在这里堆同义词。
 */
export const GOLDEN_DATASET: GoldenItem[] = [
  {
    input: { question: '你好' },
    expectedOutput: {
      intent: 'chitchat',
      forbidRetrieve: true,
      forbidGraph: true,
      forbidWeb: true,
      judgeGroundedness: false,
    },
    metadata: { id: 'chitchat-hello', suite: 'routing' },
  },
  {
    input: { question: '出差预估费用超过五千谁还要加签？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      relevantDocTitles: ['差旅'],
      keyPoints: ['张敏', '加签'],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-travel-signoff', suite: 'kb-hit' },
  },
  {
    input: { question: '加班餐补怎么报、标准是多少？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      expectRewrite: true,
      relevantDocTitles: [],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-overtime-meal', suite: 'rewrite' },
  },
  {
    input: { question: '公司年会抽奖规则是什么？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      expectRefusal: true,
      relevantDocTitles: [],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-annual-party', suite: 'kb-empty' },
  },
  {
    input: { question: '今天人民币兑美元汇率' },
    expectedOutput: {
      intent: 'web',
      requireWeb: true,
      forbidRetrieve: true,
      forbidGraph: true,
      judgeGroundedness: false,
    },
    metadata: { id: 'web-fx', suite: 'web' },
  },
  {
    input: { question: 'VPN 连不上先查什么，账号开通找谁？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      relevantDocTitles: ['信息安全'],
      keyPoints: ['张伟'],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-vpn-account', suite: 'kb-hit' },
  },
  {
    input: { question: '知识库上线怎么做灰度？谁负责窗口？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      relevantDocTitles: ['生产环境变更', '发布'],
      keyPoints: ['李明'],
      mustNotContain: ['王芳'],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-release-window', suite: 'kb-hit' },
  },
  {
    input: { question: '实习生转正答辩要交哪些材料？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      expectRefusal: true,
      relevantDocTitles: [],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-intern-defense', suite: 'kb-empty' },
  },
  {
    input: { question: '预算审核员属于哪个部门' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-not-profile', suite: 'routing' },
  },
];
