/**
 * Checks the model's TEE attestation with NEAR AI's official verifier and saves the evidence, so the desk owner can
 * approve its signing address with `set_signer`. Anyone can rerun it.
 *
 * It runs `py/model_verifier.py` from a local checkout of github.com/nearai/nearai-cloud-verifier at commit 9455472
 * (the version R1 checked), with a fresh nonce, and passes only when the report has exactly one model attestation and
 * every check holds: the Intel TDX quote verifies as UpToDate, report data binds the signer and embeds the nonce, the
 * NVIDIA verdict is true with the same nonce, and mr_config matches the attested compose file.
 * Evidence goes to attestations/<date>-<signer>.json. The API key is passed to the verifier only through its env.
 *
 *   NEAR_AI_VERIFIER_DIR=<checkout> pnpm verify:signer        (needs NEAR_AI_API_KEY)
 */
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { JUDGE_PROMPT } from '../shared/judgePrompt.ts';

const VERIFIER_COMMIT = '9455472';
const dir = process.env.NEAR_AI_VERIFIER_DIR;
const key = process.env.NEAR_AI_API_KEY;
if (!dir || !key) {
  console.error(
    'usage: NEAR_AI_VERIFIER_DIR=<checkout of nearai/nearai-cloud-verifier> pnpm verify:signer\nneeds NEAR_AI_API_KEY',
  );
  process.exit(1);
}

const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
if (!head.startsWith(VERIFIER_COMMIT)) {
  console.error(`the verifier checkout is at ${head || 'an unknown commit'}, not ${VERIFIER_COMMIT}`);
  process.exit(1);
}

const model = JUDGE_PROMPT.model;
const run = spawnSync('python3', ['py/model_verifier.py', '--model', model], {
  cwd: dir,
  encoding: 'utf8',
  env: { ...process.env, API_KEY: key },
  maxBuffer: 64 * 1024 * 1024,
  timeout: 180_000,
});
if (run.status !== 0) {
  console.error(`the verifier exited with ${run.status ?? run.signal}:\n${run.stderr}`);
  process.exit(1);
}

// The verifier prints a gateway section, then one section per model attestation.
const sections = run.stdout.split('🔐 Model attestations:').slice(1);
const checks: Record<string, boolean> = { 'exactly one model attestation': sections.length === 1 };
const body = sections[0] ?? '';
const has = (line: string) => body.includes(line);
checks['TDX quote verifies, status UpToDate'] = has('Verification successful! Status: UpToDate');
checks['report data binds the signing address'] = has('Report data binds signing address: True');
checks['report data embeds the request nonce'] = has('Report data embeds request nonce: True');
checks['GPU payload carries the same nonce'] = has('GPU payload nonce matches request_nonce: True');
checks['NVIDIA verdict true'] = has('NVIDIA attestation verdict: True');
checks['mr_config matches the compose hash'] = has('mr_config matches compose hash: True');
const signer = /Signing address:\s*(0x[0-9a-fA-F]{40})\b/.exec(body)?.[1]?.toLowerCase() ?? null;
checks['signing address found'] = signer !== null;

const ok = Object.values(checks).every(Boolean);
for (const [name, pass] of Object.entries(checks)) console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
const at = new Date().toISOString();
const evidence = {
  at,
  model,
  signer,
  ok,
  checks,
  verifier: { repo: 'https://github.com/nearai/nearai-cloud-verifier', commit: head },
  output: run.stdout,
};
const name = `${at.slice(0, 10)}-${signer ?? 'unknown'}${ok ? '' : '-FAILED'}.json`;
await mkdir(new URL('../attestations/', import.meta.url), { recursive: true });
await writeFile(new URL(`../attestations/${name}`, import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${ok ? `signer ${signer} verified for ${model}` : 'NOT verified'}; evidence in attestations/${name}`);
process.exit(ok ? 0 : 1);
