import Link from "next/link";
import type { ReactNode } from "react";
import { EnTitle } from "@/components/page-title";
import { CONTACT, CONTACT_MAILTO, LEGAL_EFFECTIVE_DATE, LEGAL_EFFECTIVE_DATE_LABEL, LEGAL_VERSION_LABEL } from "@/lib/legal";
import { cn } from "@/lib/utils";

// 이용약관(/terms)·개인정보 처리방침(/privacy)이 같이 쓰는 문서 틀. 긴 글이라 제목·목록·표는 모두 실제 h2·h3·ol·ul·table 로 그린다.
// 영어 큰 제목 한 줄은 랜딩과 같은 title-display(aria-hidden), 선은 진갈색, 본문은 Noto Sans KR 15px.

const body = "text-[15px] leading-[1.7] text-ink-body";

const DOCS = [
  { id: "terms", href: "/terms", label: "이용약관" },
  { id: "privacy", href: "/privacy", label: "개인정보 처리방침" },
] as const;

export function LegalDocument({ current, title, children }: { current: (typeof DOCS)[number]["id"]; title: string; children: ReactNode }) {
  return (
    <article className="mx-auto max-w-[800px] break-keep px-6 pt-14 pb-24 [overflow-wrap:anywhere]">
      <nav aria-label="문서" className="flex gap-6 text-sm">
        {DOCS.map((doc) => {
          const active = doc.id === current;
          return (
            <Link
              key={doc.id}
              href={doc.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center border-b-2 outline-none focus-visible:ring-2 focus-visible:ring-ink",
                active ? "border-ink font-bold text-ink" : "border-transparent font-medium text-ink-2 hover:text-ink",
              )}
            >
              {doc.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-8"><EnTitle>The fine print.</EnTitle></div>
      <h1 className="mt-1 text-[28px] leading-[1.4] font-bold">{title}</h1>
      <p className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-ink-2">
        <span className="bg-blush px-2 py-0.5 text-xs font-medium text-ink">초안 · 법률 검토 전</span>
        <span>
          시행일: <time dateTime={LEGAL_EFFECTIVE_DATE}>{LEGAL_EFFECTIVE_DATE_LABEL}</time> · 버전: {LEGAL_VERSION_LABEL}
        </span>
      </p>
      {children}
    </article>
  );
}

export function Clause({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section>
      <h2 className="mt-11 border-t-[1.5px] border-ink pt-5 text-[21px] leading-[1.5] font-bold">{title}</h2>
      {children}
    </section>
  );
}

export function Sub({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <h3 className="mt-7 text-[17px] leading-[1.5] font-bold">{title}</h3>
      {children}
    </>
  );
}

export function Para({ children }: { children: ReactNode }) {
  return <p className={cn("mt-3", body)}>{children}</p>;
}

/** 목록 한 줄: 글자만이면 문자열, 아래에 작은 목록이 붙으면 { text, sub } */
export type ListItem = string | { text: ReactNode; sub?: string[] };

function renderItems(items: ListItem[]) {
  return items.map((item, index) => {
    if (typeof item === "string") return <li key={index}>{item}</li>;
    return (
      <li key={index}>
        {item.text}
        {item.sub && (
          <ul className="mt-1.5 list-disc space-y-1 pl-5">
            {item.sub.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        )}
      </li>
    );
  });
}

export function Numbered({ items }: { items: ListItem[] }) {
  return <ol className={cn("mt-3 list-decimal space-y-1.5 pl-[22px]", body)}>{renderItems(items)}</ol>;
}

export function Bullets({ items }: { items: ListItem[] }) {
  return <ul className={cn("mt-3 list-disc space-y-1.5 pl-[22px]", body)}>{renderItems(items)}</ul>;
}

/** 표: 가로로 넘치면 영역 안에서 옆으로 밀고(키보드로도 포커스), 읽어 주는 화면에는 caption 으로 이름을 붙인다 */
export function DataTable({ label, head, rows }: { label: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="mt-3.5 overflow-x-auto border-x border-y border-ink/15 bg-white outline-none focus-visible:ring-2 focus-visible:ring-ink">
      <table className="w-full min-w-[560px] border-collapse text-[13.5px] leading-[1.6] text-ink-body">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="bg-canvas text-ink">
            {head.map((cell) => (
              <th key={cell} scope="col" className="border-b-[1.5px] border-ink px-3 py-2.5 text-left font-bold whitespace-nowrap">{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => <td key={c} className="border-b border-ink/15 px-3 py-2.5 align-top">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 책임자·이메일(·전화) 줄. 전화는 lib/legal.ts 에 값이 있을 때만 보인다 */
export function ContactList() {
  return (
    <ul className={cn("mt-3 list-disc space-y-1.5 pl-[22px]", body)}>
      <li>책임자: {CONTACT.privacyOfficer}</li>
      <li>이메일: <a href={CONTACT_MAILTO} className="underline underline-offset-2">{CONTACT.email}</a></li>
      {CONTACT.phone && <li>전화: {CONTACT.phone}</li>}
    </ul>
  );
}
