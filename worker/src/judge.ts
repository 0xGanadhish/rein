import type { DeskPrompt } from './deskTypes';

/** NEAR AI gateway. Host, paths and headers are still being confirmed live, so they all live here. */
export const NEAR_AI = {
  completions: 'https://cloud-api.near.ai/v1/chat/completions',
  signature: 'https://cloud-api.near.ai/v1/signature',
  signingAlgo: 'ecdsa',
  headers: { 'Content-Type': 'application/json', 'x-no-aliasing': 'true', 'Accept-Encoding': 'identity' },
  timeoutMs: 20_000,
  /** Published USD micros per million tokens: https://cloud-api.near.ai/v1/models */
  price: { inputPerMTok: 80_000, outputPerMTok: 500_000 },
} as const;

export class JudgeError extends Error {
  constructor(readonly stage: 'completion' | 'signature', message: string) {
    super(`${stage}: ${message}`);
    this.name = 'JudgeError';
  }
}

export interface JudgeOpts {
  /** Persists the attempt before returning or throwing; account credits are not inferred from token usage. */
  record?(call: JudgeCall): Promise<number | void>;
  apiKey?: string;
  fetch?: typeof fetch;
}

export interface JudgeCall {
  costUsdMicros: number;
  tokensIn: number | null;
  tokensOut: number | null;
  signingAddress: string;
  stage: 'completion' | 'signature' | null;
  failure: string | null;
  model: string;
}

export interface Judgement {
  request: string;
  response: string;
  signature: string;
  signingAddress: string;
  costUsdMicros: number;
  recordingId?: number;
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
  const call: JudgeCall = { costUsdMicros: 0, tokensIn: null, tokensOut: null, signingAddress: '', stage: null, failure: null, model: prompt.model };
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
    call.tokensIn = parsed.usage?.prompt_tokens ?? null;
    call.tokensOut = parsed.usage?.completion_tokens ?? null;
    call.costUsdMicros = Math.round(((call.tokensIn ?? 0) * NEAR_AI.price.inputPerMTok
      + (call.tokensOut ?? 0) * NEAR_AI.price.outputPerMTok) / 1e6);
    if (typeof parsed.id !== 'string' || !parsed.id) throw new JudgeError('completion', 'response has no id');

    stage.now = 'signature';
    const sigRes = await doFetch(`${NEAR_AI.signature}/${encodeURIComponent(parsed.id)}?signing_algo=${NEAR_AI.signingAlgo}`,
      { method: 'GET', headers, signal: ctrl.signal });
    if (!sigRes.ok) throw new JudgeError('signature', `HTTP ${sigRes.status}`);
    const sig = await sigRes.json<{ signature?: unknown; signing_address?: unknown }>();
    if (typeof sig.signature !== 'string' || typeof sig.signing_address !== 'string') {
      throw new JudgeError('signature', 'missing signature or signing_address');
    }
    call.signingAddress = sig.signing_address;
    return { request, response, signature: sig.signature, signingAddress: sig.signing_address, costUsdMicros: call.costUsdMicros };
  };

  let result: Judgement;
  try {
    result = await Promise.race([
      run().catch((e: unknown) => {
        throw e instanceof JudgeError ? e : new JudgeError(stage.now, e instanceof Error ? e.message : String(e));
      }),
      timeout,
    ]);
  } catch (e) {
    call.stage = stage.now;
    call.failure = e instanceof JudgeError ? e.message : `${stage.now}: call failed`;
    await opts.record?.(call);
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const id = await opts.record?.(call);
  if (typeof id === 'number') result.recordingId = id;
  return result;
}
