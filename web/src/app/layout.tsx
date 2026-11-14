import type { Metadata } from "next";
import { Fredoka, Noto_Sans_KR } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// 새 피그마 글꼴: 본문 전체 Noto Sans KR (400/500/700), "SyncUp" 워드마크만 Fredoka Bold.
// 한글 글리프는 구글이 쪼갠 조각(unicode-range)으로 필요한 만큼만 내려받고, 미리 불러오는 것은 라틴 조각뿐이다.
const notoSansKr = Noto_Sans_KR({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-noto-sans-kr",
});
const fredoka = Fredoka({
  weight: "700",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-fredoka",
});

export const metadata: Metadata = {
  title: "Sync up · 싱크업",
  description: "팀원마다 다른 AI를 써도 팀의 결정은 하나로 — 대학생 팀플을 위한 AI 공유 메모리",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${notoSansKr.variable} ${fredoka.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-canvas">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
