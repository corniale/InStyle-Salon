import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Static export so the app can be served from GitHub Pages (or any static
  // host). All data access is client-side through Supabase; auth gating is
  // client-side too (src/app/(app)/layout.tsx). RLS remains the real control.
  output: "export",
  trailingSlash: true,
  // GitHub Pages serves a project site under /<repo>/ — the workflow sets
  // NEXT_PUBLIC_BASE_PATH=/InStyle-Salon. Local dev leaves it empty.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  images: { unoptimized: true },
};

export default nextConfig;
