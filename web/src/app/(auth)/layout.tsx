import { AuthNavLink } from "@/components/auth-nav-link";
import { Brand } from "@/components/brand";

// 로그인 화면 (피그마 Page 9 · 300:2): 헤더는 로고와 오른쪽 '로그인'(현재 화면 · 2px 밑줄)만 둔다. 가입 동의 화면은 로고만
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-canvas">
      <header className="border-b bg-canvas">
        <div className="mx-auto flex h-16 max-w-wide items-center justify-between px-gutter md:px-8">
          <Brand />
          <AuthNavLink />
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
