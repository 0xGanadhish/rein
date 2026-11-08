import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { judge, NEAR_AI } from '../src/judge';
import type { DeskPrompt } from '../src/deskTypes';

const prompt: DeskPrompt = {
  model: 'z-ai/glm-5.3-flash',
  prefix: '{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":"',
  suffix: '"}]}',
};
const doc = 'rein-v1|order=1|chain=base|vault=0xaa|at=1|name=x';
// Odd spacing and a non-ASCII character: the bytes must come back untouched, not re-serialised.
const completion =
  '{"id":"chatcmpl-7",  "choices":[{"message":{"content":"{\\"verdict\\":\\"HOLD\\"} \u00e9"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n';
const signature = { signature_kind: 'ecdsa', text: 'a:b', signature: '0xsig', signing_address: '0xSigner' };

type Call = { url: string; init: RequestInit };

function fakeFetch(calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.startsWith(NEAR_AI.completions)) return new Response(completion);
    return new Response(JSON.stringify(signature));
  }) as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('judge', () => {
  it('failed_judge_call_is_recorded', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare('DELETE FROM judge_calls').run();
    const opts = {
      apiKey: 'test-only',
      fetch: (async (input: RequestInfo | URL) =>
        String(input) === NEAR_AI.completions
          ? new Response('{"id":"billable","usage":{"prompt_tokens":244,"completion_tokens":34}}')
          : new Response('unavailable', { status: 503 })) as typeof fetch,
      record: async (call: { costUsdMicros: number; stage: string | null }) => {
        await env.DB.prepare(
          'INSERT INTO judge_calls (order_id, at, signing_address, cost_usd_micros) VALUES (1, 1, ?, ?)',
        )
          .bind(call.stage, call.costUsdMicros)
          .run();
      },
    };
    await expect(judge(doc, prompt, opts)).rejects.toThrow('signature: HTTP 503');
    expect(await env.DB.prepare('SELECT signing_address, cost_usd_micros FROM judge_calls').first()).toEqual({
      signing_address: 'signature',
      cost_usd_micros: 37,
    });
  });
  it('sends_exact_prefix_doc_suffix', async () => {
    const calls: Call[] = [];
    const r = await judge(doc, prompt, { apiKey: 'k', fetch: fakeFetch(calls) });
    expect(calls[0].url).toBe(NEAR_AI.completions);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(prompt.prefix + doc + prompt.suffix);
    expect(r.request).toBe(prompt.prefix + doc + prompt.suffix);
  });

  it('asks_for_identity_encoding', async () => {
    const calls: Call[] = [];
    await judge(doc, prompt, { apiKey: 'k', fetch: fakeFetch(calls) });
    for (const c of calls) {
      const h = new Headers(c.init.headers);
      expect(h.get('accept-encoding')).toBe('identity');
      expect(h.get('x-no-aliasing')).toBe('true');
      expect(h.get('authorization')).toBe('Bearer k');
    }
  });

  it('returns_exact_response_bytes', async () => {
    const calls: Call[] = [];
    const r = await judge(doc, prompt, { apiKey: 'k', fetch: fakeFetch(calls) });
    expect(r.response).toBe(completion);
    expect(calls[1].url).toBe(`${NEAR_AI.signature}/chatcmpl-7?signing_algo=ecdsa`);
    expect(r.signature).toBe('0xsig');
    expect(r.signingAddress).toBe('0xSigner');
  });

  it('times_out_after_20s', async () => {
    vi.useFakeTimers();
    const hang = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    let settled = false;
    const p = judge(doc, prompt, { apiKey: 'k', fetch: hang }).finally(() => {
      settled = true;
    });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toThrow(/timed out after 20s/);
  });
});
