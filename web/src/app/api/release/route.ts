import { NextResponse } from "next/server";
import release from "@/lib/extension-release.json";

// Public build metadata only. No credential, account, local connection path, or provider token is exposed.
export async function GET() {
  return NextResponse.json({ extensionVersion: release.version,
    dataMode: process.env.NEXT_PUBLIC_USE_MOCK === "true" ? "demo" : "real",
    webOrigin: process.env.SYNCUP_WEB_ORIGIN ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}
