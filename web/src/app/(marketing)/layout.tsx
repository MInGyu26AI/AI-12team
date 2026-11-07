import { LandingHeader } from "@/components/landing-header";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LandingHeader />
      <div className="flex-1">{children}</div>
      <footer className="border-t">
        <p className="mx-auto max-w-wide px-gutter py-6 text-sm text-muted-foreground">Sync up · Shared Memory for Students</p>
      </footer>
    </>
  );
}
