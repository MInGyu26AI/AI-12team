import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Serif, Inter_Tight, Noto_Sans_KR, Orbitron } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// 시안 "로즈 & 올리브 수채화" 글꼴: 한글 본문 Noto Sans KR, 영어 큰 제목 Inter Tight 800, 작은 라벨 IBM Plex Mono,
// 이탤릭 포인트 Instrument Serif, 로고 글자 Orbitron 900. 한글 글리프는 구글이 쪼갠 조각(unicode-range)으로 필요한 만큼만 내려받는다.
const notoSansKr = Noto_Sans_KR({ weight: ["300", "400", "500", "700", "800"], subsets: ["latin"], display: "swap", variable: "--font-noto-sans-kr" });
const interTight = Inter_Tight({ weight: "800", subsets: ["latin"], display: "swap", variable: "--font-inter-tight" });
const plexMono = IBM_Plex_Mono({ weight: ["400", "500"], subsets: ["latin"], display: "swap", variable: "--font-plex-mono" });
const instrumentSerif = Instrument_Serif({ weight: "400", style: "italic", subsets: ["latin"], display: "swap", variable: "--font-instrument-serif" });
const orbitron = Orbitron({ weight: "900", subsets: ["latin"], display: "swap", variable: "--font-orbitron" });

export const metadata: Metadata = {
  title: "Sync up · 싱크업",
  description: "팀원마다 다른 AI를 써도 팀의 결정은 하나로 — 대학생 팀플을 위한 AI 공유 메모리",
};

const fontVars = [notoSansKr, interTight, plexMono, instrumentSerif, orbitron].map((f) => f.variable).join(" ");

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${fontVars} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-canvas">
        {process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && <div className="border-b bg-amber-50 px-4 py-2 text-center text-sm text-amber-950">시험용 SyncUp · 이 Mac의 별도 팀 데이터로 진행합니다.</div>}
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
