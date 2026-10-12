import { Agent, type Dispatcher } from "undici";

/** The whole cloud round and each model response share this upper bound. */
export const HOSTED_AGENT_TIMEOUT_MS = 12 * 60 * 1000;

/** A private pool per execution, never a process-wide fetch override. */
export function createHostedModelDispatcher(factory?: Agent.Options["factory"]): Agent {
  return new Agent({ headersTimeout: HOSTED_AGENT_TIMEOUT_MS, bodyTimeout: HOSTED_AGENT_TIMEOUT_MS,
    connectTimeout: 30_000, connections: 1, maxOrigins: 1, ...(factory ? { factory } : {}) });
}

/** Error details never leave the host; only known transport timeout categories do. */
export function isHostedTransportTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const candidate = error as Error & { code?: unknown; cause?: unknown };
  if (["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(String(candidate.code))) return true;
  const cause = candidate.cause;
  return cause instanceof Error && isHostedTransportTimeout(cause);
}

export async function destroyHostedModelDispatcher(dispatcher: Dispatcher | undefined): Promise<void> {
  await dispatcher?.destroy();
}
