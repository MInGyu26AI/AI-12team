import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sync up · 싱크업",
  description: "팀원마다 다른 AI를 써도 팀의 결정은 하나로 — 대학생 팀플을 위한 AI 공유 메모리",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="flex min-h-full flex-col bg-background">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
