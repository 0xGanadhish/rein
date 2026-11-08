import { maxUint256 } from 'viem';

export type InputCheck = 'match' | 'mismatch' | 'unknown';

/** The oracle's own snapshot of the vault at post time. Liquidity is `maxUint256` when the vault has no adapter. */
export interface PostSnapshot {
  ppsAtPost: bigint;
  assetsAtPost: bigint;
  liquidityAtPost: bigint;
}

/** Tolerances in parts per million: share price 0.1%, assets and liquidity 2%. */
const PPS_PPM = 1_000n;
const ASSETS_PPM = 20_000n;
const LIQUIDITY_PPM = 20_000n;

function fields(doc: string): Map<string, string> | null {
  const [head, ...rest] = doc.split('|');
  if (head !== 'rein-v1') return null;
  const out = new Map<string, string>();
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

const within = (got: bigint, want: bigint, ppm: bigint) =>
  (got > want ? got - want : want - got) * 1_000_000n <= want * ppm;

/**
 * Whether the reading the model was shown agrees with what the oracle snapshotted when the post landed. A doc that
 * can't be read is `unknown`. Liquidity is compared as basis points of total assets, the doc's precision.
 */
export function inputCheck(doc: string, post: PostSnapshot): InputCheck {
  const f = fields(doc);
  const pps = f?.get('pps');
  const assets = f?.get('assets');
  const liquidity = f?.get('liquidity');
  if (!pps || !assets || !liquidity || !/^\d+$/.test(pps) || !/^\d+$/.test(assets)) return 'unknown';
  if (liquidity !== 'na' && !/^\d+(\.\d{1,2})?$/.test(liquidity)) return 'unknown';
  // APY is not observable in the oracle snapshot. Validate its representation, never compare na as zero.
  for (const key of ['apy_bps', 'apy_bps_prev']) {
    const apy = f?.get(key);
    if (apy !== undefined && apy !== 'na' && !/^-?\d+$/.test(apy)) return 'unknown';
  }

  if (!within(BigInt(pps), post.ppsAtPost, PPS_PPM)) return 'mismatch';
  if (!within(BigInt(assets), post.assetsAtPost, ASSETS_PPM)) return 'mismatch';

  const noAdapter = post.liquidityAtPost === maxUint256;
  if (liquidity === 'na' || noAdapter) return liquidity === 'na' && noAdapter ? 'match' : 'mismatch';
  const docBps = BigInt(Math.round(Number(liquidity) * 100));
  const postBps =
    post.assetsAtPost === 0n || post.liquidityAtPost >= post.assetsAtPost
      ? 10_000n
      : (post.liquidityAtPost * 10_000n) / post.assetsAtPost;
  return within(docBps, postBps, LIQUIDITY_PPM) ? 'match' : 'mismatch';
}
