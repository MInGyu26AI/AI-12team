import path from "node:path";
import type { NextConfig } from "next";

// 레포 최상위 (web 과 shared 를 모두 포함). Vercel 에서 Root Directory 를 web 으로 해도
// ../shared 를 import 할 수 있도록 Turbopack 루트와 파일 추적 루트를 여기로 맞춘다.
const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  outputFileTracingRoot: repoRoot,
  async redirects() {
    return [{ source: "/", destination: "/board", permanent: false }];
  },
  turbopack: {
    root: repoRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
