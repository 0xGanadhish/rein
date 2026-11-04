import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The ledger's types and scoring live in ../shared, next to the Worker.
  experimental: { externalDir: true },
  // Server code reads fixtures/ with fs when DATA_SOURCE=fixtures; make sure the deployment bundles them.
  outputFileTracingIncludes: { '/**': ['./fixtures/**/*'] },
};

export default nextConfig;
