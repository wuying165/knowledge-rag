import { Logger } from '@nestjs/common';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  startActiveObservation,
  propagateAttributes,
} from '@langfuse/tracing';

const logger = new Logger('Langfuse');

let sdk: NodeSDK | undefined;

/** 配了公私钥才上报；评测脚本同样依赖这组变量。 */
export function isLangfuseEnabled(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
  );
}

export function startLangfuseTracing(): void {
  if (sdk || !isLangfuseEnabled()) return;
  sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();
  logger.log(
    `Langfuse tracing 已启动 baseUrl=${process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com'}`,
  );
}

export async function shutdownLangfuseTracing(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}

export async function withObservation<T>(
  name: string,
  run: (update: (fields: Record<string, unknown>) => void) => Promise<T>,
): Promise<T> {
  if (!isLangfuseEnabled()) {
    return run(() => undefined);
  }
  return startActiveObservation(name, async (span) =>
    run((fields) => {
      span.update(fields);
    }),
  );
}

export async function withTraceAttrs<T>(
  attrs: {
    userId?: string;
    sessionId?: string;
    tags?: string[];
  },
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangfuseEnabled()) return run();
  return propagateAttributes(attrs, run);
}
