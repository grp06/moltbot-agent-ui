import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ws", "better-sqlite3"],
  // Workaround for Next.js 16 Turbopack prerender bug
  // https://github.com/vercel/next.js/discussions/86978
  experimental: {
    // Disable static page generation for problematic routes
    disableOptimizedLoading: true,
  },
  // Skip static generation for all pages to avoid prerender errors
  output: 'standalone',
};

export default nextConfig;
