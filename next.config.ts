import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow large JSON API responses (graph file can be 36MB)
  experimental: {},
  // Serve static data files from /public if needed
};

export default nextConfig;
