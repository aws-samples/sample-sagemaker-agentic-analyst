import type { NextConfig } from 'next';

const allowedOrigins = ['localhost:3012'];
if (process.env.ALLOWED_ORIGIN_HOST) {
  allowedOrigins.push(process.env.ALLOWED_ORIGIN_HOST);
}

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@agentic-analyst/datazone-auth', '@agentic-analyst/shared-types'],
  experimental: {
    webpackBuildWorker: true,
    parallelServerBuildTraces: true,
    parallelServerCompiles: true,
    serverActions: {
      allowedOrigins,
    },
  },
  typescript: {
    ignoreBuildErrors: process.env.SKIP_TS_BUILD == 'true',
  },
};

export default nextConfig;
