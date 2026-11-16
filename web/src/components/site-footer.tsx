import Link from "next/link";
import { BETA_BADGE, CONTACT, CONTACT_MAILTO } from "@/lib/legal";

const link = "flex min-h-11 items-center text-sm text-ink outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ink";

// 첫 화면·소개·약관 같은 공개 화면의 푸터 (디자인 Footer.dc.html). 왼쪽 서비스 이름과 베타 안내, 오른쪽 약관·처리방침·문의 링크,
// 맨 아래 줄에 운영자·개인정보 보호책임자와 OpenAI 상표 안내. 좁은 화면에서는 위아래로 쌓인다
export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-5 px-gutter py-8 sm:px-10 lg:px-20">
        <div className="flex flex-wrap items-start justify-between gap-x-12 gap-y-5">
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium text-ink-2">SyncUp · Shared Memory for Students</p>
            <p className="flex items-center gap-2 text-xs text-ink-2">
              <span className="bg-blush px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] text-ink">{BETA_BADGE}</span>
              <span>베타 서비스이며 무료예요</span>
            </p>
          </div>
          <nav aria-label="약관과 문의" className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <Link href="/terms" className={link}>이용약관</Link>
            <Link href="/privacy" className={`${link} font-bold underline underline-offset-4`}>개인정보 처리방침</Link>
            <a href={CONTACT_MAILTO} className={link}>문의</a>
          </nav>
        </div>
        <div className="flex flex-wrap justify-between gap-x-8 gap-y-2 border-t border-ink/15 pt-4">
          <p className="text-xs leading-[1.6] text-ink-2">운영 {CONTACT.operator} · 개인정보 보호책임자 {CONTACT.privacyOfficer} · {CONTACT.email}</p>
          <p className="text-xs leading-[1.6] text-ink-2">ChatGPT는 OpenAI의 상표이며, SyncUp은 OpenAI와 제휴 관계가 없습니다</p>
        </div>
      </div>
    </footer>
  );
}
