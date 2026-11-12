import type { DeskPolicy } from '../../../../shared/desk';
import { publicConfig } from '@/lib/config';
import { readOrders } from '@/lib/desk';
import { nearBalance, view } from '@/lib/near';

/** The header's wallet panel: the connected account's NEAR and USDC balances and its orders with Rein. */
export async function GET(request: Request) {
  const account = new URL(request.url).searchParams.get('account');
  if (!account) return Response.json({ error: 'account required' }, { status: 400 });
  const cfg = await publicConfig();
  const usdcToken = cfg.desk
    ? await view<DeskPolicy>(cfg.network, cfg.desk, 'policy')
        .then((p) => p.usdc_token)
        .catch(() => null)
    : null;
  const [near, usdc, orders] = await Promise.all([
    nearBalance(cfg.network, account).catch(() => null),
    usdcToken ? view<string>(cfg.network, usdcToken, 'ft_balance_of', { account_id: account }).catch(() => null) : null,
    readOrders(account).catch(() => null),
  ]);
  return Response.json({ network: cfg.network, near, usdc, usdcToken, orders });
}
