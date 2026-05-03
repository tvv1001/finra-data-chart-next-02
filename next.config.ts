import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // Compress API + page responses with gzip/brotli
  compress: true,
  experimental: {
    // Allow huge graph JSON to be serialised through getServerSideProps / route handlers
    largePageDataBytes: 128 * 1024 * 1024, // 128 MB
  },
};

export default nextConfig;
