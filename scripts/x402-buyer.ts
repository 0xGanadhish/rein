/**
 * Calls the x402 v2 judgement endpoint. Supply a base64 PAYMENT-SIGNATURE from a client that handles
 * quote/deposit payloads; this helper never deposits funds. Credit redemption requires an explicit flag.
 *
 *   node --experimental-strip-types scripts/x402-buyer.ts <worker-url> <chain> <vault> [payment-signature] [--redeem-credit]
 */
const [base, chain, vault, payment, action] = process.argv.slice(2);
if (!base || !chain || !vault) {
  console.error(
    'usage: node --experimental-strip-types scripts/x402-buyer.ts <worker-url> <chain> <vault> [payment-signature] [--redeem-credit]',
  );
  process.exit(1);
}

const url = new URL('/v1/x402/judge', base);
const ask = (headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ chain, vault, redeemCredit: action === '--redeem-credit' }),
  });

const response = await ask(payment ? { 'PAYMENT-SIGNATURE': payment } : {});
console.log(response.status, JSON.stringify(await response.json(), null, 2));
const receipt = response.headers.get('PAYMENT-RESPONSE');
if (receipt) console.log('settlement', JSON.stringify(JSON.parse(atob(receipt)), null, 2));
