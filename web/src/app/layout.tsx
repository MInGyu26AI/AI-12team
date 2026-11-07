import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "싱크업",
  description: "팀 AI 메모리: 승인한 결정만 모으고, 충돌을 경고합니다",
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
      <body className="flex min-h-full flex-col bg-muted/30">
        <SiteHeader />
        <main className="mx-auto w-full max-w-content flex-1 px-gutter py-6">{children}</main>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
