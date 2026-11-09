import type { Metadata } from 'next';
import { Funnel_Display, Funnel_Sans, Martian_Mono } from 'next/font/google';
import { NearWalletProvider } from '@/components/near/NearWallet';
import { publicConfig } from '@/lib/config';
import './globals.css';

const display = Funnel_Display({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const sans = Funnel_Sans({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = Martian_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Rein', template: '%s · Rein' },
  description: 'Signed HOLD, EXIT and MOVE calls on yield vaults, graded in public.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { network, desk } = await publicConfig();
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <NearWalletProvider network={network} desk={desk}>
          {children}
        </NearWalletProvider>
      </body>
    </html>
  );
}
