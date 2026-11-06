import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // File resolvers read public/ and DATA_DIR at runtime. Never trace checkout
  // backups, test artifacts, or live databases into the application package.
  outputFileTracingExcludes: {
    "/*": ["./backup/**/*", "./backups/**/*", "./data/**/*", "./work/**/*", "./.env*", "./**/*.sqlite*", "./**/*.db*"],
  },
  poweredByHeader: false,
  // Keep builds usable on the existing 2 GiB ECS instance.
  experimental: { cpus: 1 },
};

export default nextConfig;
