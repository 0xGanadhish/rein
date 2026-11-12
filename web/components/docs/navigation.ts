export type DocGroup = 'Start' | 'Use Rein' | 'Check it' | 'Developers';

export interface DocPage {
  href: string;
  title: string;
  description: string;
  group: DocGroup;
}

/** Every docs page, in reading order. The hub is /docs; the sidebar and prev/next follow this order. */
export const DOC_PAGES: DocPage[] = [
  { href: '/docs', title: 'Overview', description: 'The actors, networks and where to start.', group: 'Start' },
  {
    href: '/docs/verdict',
    title: 'How a verdict is made',
    description: 'From a pinned reading to a delivered post.',
    group: 'Start',
  },
  {
    href: '/docs/judge',
    title: 'Judge a vault',
    description: 'NEAR, USDC, x402 and cross-chain top-up.',
    group: 'Use Rein',
  },
  {
    href: '/docs/ledger',
    title: 'Ledger and grading',
    description: 'Onchain outcomes, count-once calls and Brier error.',
    group: 'Use Rein',
  },
  {
    href: '/docs/guardian',
    title: 'Guardian and MOVE',
    description: 'Opt-in exits and quotes after an exit.',
    group: 'Use Rein',
  },
  {
    href: '/docs/receipts',
    title: 'Verify a receipt',
    description: 'What the receipt checks—and what it cannot prove.',
    group: 'Check it',
  },
  {
    href: '/docs/trust',
    title: 'Trust and limits',
    description: 'Verified boundaries, trusted inputs and operational risks.',
    group: 'Check it',
  },
  {
    href: '/docs/api',
    title: 'HTTP API',
    description: 'Worker routes, payloads, errors and limits.',
    group: 'Developers',
  },
  {
    href: '/docs/mcp',
    title: 'MCP server',
    description: 'Five tools over local stdio or remote HTTP.',
    group: 'Developers',
  },
  {
    href: '/docs/x402',
    title: 'x402 payments',
    description: 'Upfront settlement, resuming and one-use credits.',
    group: 'Developers',
  },
];

export const DOC_GROUPS: DocGroup[] = ['Start', 'Use Rein', 'Check it', 'Developers'];

export const docPage = (href: string) => DOC_PAGES.find((p) => p.href === href);
/** Two-digit topic number, as shown on cards: "02". */
export const docNum = (p: DocPage) => String(DOC_PAGES.indexOf(p)).padStart(2, '0');
