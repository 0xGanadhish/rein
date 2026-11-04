/**
 * Tries POST /v1/x402/judge by hand: asks once without payment and prints the requirements, then, given a payment
 * header from a PingPay/x402 wallet, asks again with it.
 *
 *   node --experimental-strip-types scripts/x402-buyer.ts <worker-url> <chain> <vault> [x-payment-header]
 */
const [base, chain, vault, payment] = process.argv.slice(2);
if (!base || !chain || !vault) {
  console.error('usage: node --experimental-strip-types scripts/x402-buyer.ts <worker-url> <chain> <vault> [x-payment-header]');
  process.exit(1);
}

const url = new URL('/v1/x402/judge', base);
const ask = (headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ chain, vault }) });

const first = await ask();
console.log(first.status, JSON.stringify(await first.json(), null, 2));
if (first.status !== 402 || !payment) process.exit(0);

const paid = await ask({ 'X-PAYMENT': payment });
console.log(paid.status, JSON.stringify(await paid.json(), null, 2));
const receipt = paid.headers.get('X-PAYMENT-RESPONSE');
if (receipt) console.log('settlement', JSON.stringify(JSON.parse(atob(receipt)), null, 2));
