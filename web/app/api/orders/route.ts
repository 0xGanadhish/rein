import { readOrders } from '@/lib/desk';

/** A NEAR account's orders, for My orders (the account is only known in the browser). */
export async function GET(request: Request) {
  const payer = new URL(request.url).searchParams.get('payer');
  if (!payer) return Response.json({ error: 'payer required' }, { status: 400 });
  try {
    return Response.json({ orders: await readOrders(payer) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'unavailable' }, { status: 502 });
  }
}
