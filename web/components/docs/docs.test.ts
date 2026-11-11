import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const web = fileURLToPath(new URL('../..', import.meta.url));
const text = (path: string) => readFileSync(join(web, path), 'utf8');

test('docs_nav_lists_every_page', () => {
  const root = join(web, 'app/docs');
  const pages = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'page.tsx')
    .map((entry) => `/docs/${relative(root, entry.parentPath)}`.replace(/\/$/, ''))
    .sort();
  const nav = [...text('components/docs/navigation.ts').matchAll(/href: '(\/docs[^']*)'/g)].map((m) => m[1]).sort();
  expect(nav).toEqual(pages);
});

test('docs_api_lists_every_worker_route', () => {
  const source = text('../worker/src/api.ts');
  const routes = new Set([...source.matchAll(/app\.(?:get|post)\('([^']+)'/g)].map((m) => m[1]));
  for (const match of source.matchAll(/\['(\/v1\/alerts\/[^']+)', (?:true|false)\]/g)) routes.add(match[1]);
  const nudge = /const NUDGE_PATH = '([^']+)'/.exec(source);
  if (nudge) routes.add(nudge[1]);
  if (/mountMcp\(app,/.test(source)) routes.add('/mcp');
  const api = text('app/docs/api/page.tsx');
  for (const route of routes) expect(api, route).toContain(route);
});
