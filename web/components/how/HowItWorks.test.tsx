import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HowItWorks } from './HowItWorks';

describe('how it works', () => {
  it('how_it_works_lists_the_disclosed_limits', () => {
    const html = renderToStaticMarkup(<HowItWorks />);
    const checks = html.match(/<ol[^>]*aria-label="What the desk checks"[\s\S]*?<\/ol>/)?.[0] ?? '';
    expect(checks.match(/<li/g)).toHaveLength(7);
    const limits = html.match(/<ul[^>]*aria-label="Disclosed limits"[\s\S]*?<\/ul>/)?.[0] ?? '';
    for (const name of ['False inputs', 'Signer approval', 'Withholding', 'The model', 'Verifier scope', 'Delivery reports', 'x402 payments']) {
      expect(limits).toContain(name);
    }
    expect(limits).toContain('Temperature 0');
    expect(limits).toMatch(/credit for one free judgement/);
    expect(html).toContain('href="https://tarefi.xyz"');
  });
});
