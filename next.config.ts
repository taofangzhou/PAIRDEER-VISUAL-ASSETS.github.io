import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Keep builds usable on the existing 2 GiB ECS instance.
  experimental: { cpus: 1 },
};

export default nextConfig;
