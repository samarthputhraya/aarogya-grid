import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /*
   * Standalone output for Cloud Run.
   *
   * Next traces the modules the server actually needs and emits a
   * self-contained bundle, so the runtime image carries no node_modules tree.
   * That matters here for a specific reason: `src/data/districts/` is 128 files
   * and ~16 MB, and it has to be present at build time for the 128 prerendered
   * district routes. Shipping the whole dependency tree on top of it would make
   * a container slow to pull, and cold-start latency is visible in a demo.
   */
  output: 'standalone',
};

export default nextConfig;
