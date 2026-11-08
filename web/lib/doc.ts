/** The fields of a `rein-v1|k=v|…` reading (worker/src/doc.ts), in order. */
export function parseDoc(doc: string): [string, string][] {
  return doc
    .split('|')
    .slice(1)
    .map((f) => {
      const i = f.indexOf('=');
      return i < 0 ? [f, ''] : [f.slice(0, i), f.slice(i + 1)];
    });
}

/** The watch feed's triggers (worker/src/watch.ts), used to mark the fields that look wrong. */
const OUTFLOW_PCT = 5;
const APY_MOVE_BPS = 50;
const LOW_LIQUIDITY_PCT = 15;

/** Fields worth flagging: thin liquidity, a big hourly outflow, or a jump in APY. */
export function hotFields(fields: [string, string][]): Set<string> {
  const f = Object.fromEntries(fields);
  const hot = new Set<string>();
  if (f.liquidity && f.liquidity !== 'na' && Number(f.liquidity) < LOW_LIQUIDITY_PCT) hot.add('liquidity');
  if (Number(f.net_out_pct_1h) > OUTFLOW_PCT) hot.add('net_out_pct_1h');
  if (Math.abs(Number(f.apy_bps) - Number(f.apy_bps_prev)) >= APY_MOVE_BPS) {
    hot.add('apy_bps');
    hot.add('apy_bps_prev');
  }
  return hot;
}
