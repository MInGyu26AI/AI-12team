import { Suspense } from "react";
import { JoinForm } from "./join-form";

// 초대 링크 /join/SYNC-12 — 주소의 코드(params)는 요청 때 정해지므로 Suspense 안에서 읽는다
export default function JoinPage({ params }: PageProps<"/join/[code]">) {
  return (
    <Suspense fallback={<p className="py-16 text-center text-sm text-muted-foreground">불러오는 중…</p>}>
      <JoinForm params={params} />
    </Suspense>
  );
}
