import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The salon runs this on ordinary hardware over provincial connections;
  // keep the bundle honest.
  reactStrictMode: true,
};

export default nextConfig;
