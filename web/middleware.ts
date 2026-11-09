import { NextResponse, type NextRequest } from 'next/server';

/** Same name as NETWORK_COOKIE in lib/config.ts, which can't be imported here because it reads next/headers. */
const COOKIE = 'rein-network';

/**
 * `?network=mainnet|testnet` on any page switches the whole site to that network: it sets the cookie the pages read
 * and redirects to the same page without the parameter, so a shared link and the header switch agree.
 */
export function middleware(req: NextRequest) {
  const asked = req.nextUrl.searchParams.get('network');
  if (asked !== 'mainnet' && asked !== 'testnet') return NextResponse.next();
  const url = req.nextUrl.clone();
  url.searchParams.delete('network');
  const res = NextResponse.redirect(url);
  res.cookies.set(COOKIE, asked, { path: '/', maxAge: 31_536_000, sameSite: 'lax' });
  return res;
}

export const config = { matcher: ['/((?!_next/|favicon|.*\\.).*)'] };
