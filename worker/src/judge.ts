import type { DeskPrompt } from './deskTypes';

/** NEAR AI gateway. Host, paths and headers are still being confirmed live, so they all live here. */
export const NEAR_AI = {
  completions: 'https://cloud-api.near.ai/v1/chat/completions',
  signature: 'https://cloud-api.near.ai/v1/signature',
  signingAlgo: 'ecdsa',
  headers: { 'Content-Type': 'application/json', 'x-no-aliasing': 'true', 'Accept-Encoding': 'identity' },
  timeoutMs: 20_000,
  /** USD micros per million tokens. Unconfirmed: costs read 0 until these are set. */
  price: { inputPerMTok: 0, outputPerMTok: 0 },
} as const;

export class JudgeError extends Error {
  constructor(readonly stage: 'completion' | 'signature', message: string) {
    super(`${stage}: ${message}`);
    this.name = 'JudgeError';
  }
}

export interface JudgeOpts {
  apiKey?: string;
  fetch?: typeof fetch;
}

export interface Judgement {
  request: string;
  response: string;
  signature: string;
  signingAddress: string;
  costUsdMicros: number;
}

/**
 * Asks the TEE model for a verdict on `doc`. The request body is `prefix + doc + suffix`, byte for byte, and the
 * response comes back exactly as received: the desk hashes both to check the TEE signature, so nothing here
 * re-serialises or hashes them. The whole call, signature included, times out after 20 s.
 */
export async function judge(doc: string, prompt: DeskPrompt, opts: JudgeOpts): Promise<Judgement> {
  if (!opts.apiKey) throw new JudgeError('completion', 'no API key');
  const doFetch = opts.fetch ?? fetch;
  const headers = { ...NEAR_AI.headers, Authorization: `Bearer ${opts.apiKey}` };
  const stage = { now: 'completion' as JudgeError['stage'] };
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new JudgeError(stage.now, `timed out after ${NEAR_AI.timeoutMs / 1000}s`));
    }, NEAR_AI.timeoutMs);
  });
  const run = async (): Promise<Judgement> => {
    const request = prompt.prefix + doc + prompt.suffix;
    const res = await doFetch(NEAR_AI.completions, { method: 'POST', headers, body: request, signal: ctrl.signal });
    const response = await res.text();
    if (!res.ok) throw new JudgeError('completion', `HTTP ${res.status}`);
    let parsed: { id?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try { parsed = JSON.parse(response); } catch { throw new JudgeError('completion', 'response is not JSON'); }
    if (typeof parsed.id !== 'string' || !parsed.id) throw new JudgeError('completion', 'response has no id');

    stage.now = 'signature';
    const sigRes = await doFetch(`${NEAR_AI.signature}/${encodeURIComponent(parsed.id)}?signing_algo=${NEAR_AI.signingAlgo}`,
      { method: 'GET', headers, signal: ctrl.signal });
    if (!sigRes.ok) throw new JudgeError('signature', `HTTP ${sigRes.status}`);
    const sig = await sigRes.json<{ signature?: unknown; signing_address?: unknown }>();
    if (typeof sig.signature !== 'string' || typeof sig.signing_address !== 'string') {
      throw new JudgeError('signature', 'missing signature or signing_address');
    }
    const usage = parsed.usage ?? {};
    const costUsdMicros = Math.round(((usage.prompt_tokens ?? 0) * NEAR_AI.price.inputPerMTok
      + (usage.completion_tokens ?? 0) * NEAR_AI.price.outputPerMTok) / 1e6);
    return { request, response, signature: sig.signature, signingAddress: sig.signing_address, costUsdMicros };
  };

  try {
    return await Promise.race([
      run().catch((e: unknown) => {
        throw e instanceof JudgeError ? e : new JudgeError(stage.now, e instanceof Error ? e.message : String(e));
      }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
