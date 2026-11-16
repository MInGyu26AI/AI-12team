import type { Metadata } from "next";
import { ConsentForm } from "@/components/signup/consent-form";

// 가입 동의 (GitHub 로그인 직후, 약관·처리방침에 아직 동의하지 않은 계정). 본문은 브라우저에서 계정을 확인하는 클라이언트 화면이라 components/signup/consent-form.tsx 에 있고,
// 여기서는 탭 제목과 검색 제외만 정한다
export const metadata: Metadata = { title: "약관 동의 · Sync up", robots: { index: false } };

export default function ConsentPage() {
  return <ConsentForm />;
}
