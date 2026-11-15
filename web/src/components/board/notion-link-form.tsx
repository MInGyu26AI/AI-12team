"use client";

// 팀 기록을 저장할 노션 페이지 연결 카드: 머리 → 입력 + '연결 확인' → 상태 한 줄 → 마지막 저장 · 해제.
// 확인·연결·해제는 로컬 수집기 RPC team.verifyNotion · team.linkNotion · team.unlinkNotion (docs/team-server.md '팀별 연결 (웹)').
// 토큰은 입력칸에서 바로 수집기로만 가고 화면 상태에 다시 나타나지 않는다 (서버는 tokenSet 만 돌려준다).
// 색과 크기는 figma-ui(#10) 카드 값을 그대로 쓴다. #10이 합쳐지면 surface.ts 토큰으로 바꾼다.
import { useEffect, useState } from "react";
import { BookText } from "lucide-react";
import { fmtMDHM } from "@shared/format";
import { api } from "@/lib/api";
import type { NotionLinkResult, NotionRefusal, NotionStatus } from "@/lib/api/types";

const REASON: Record<NotionRefusal, string> = {
  "bad-format": "페이지 주소(또는 ID)나 시크릿 형식을 확인하세요",
  "token-needed": "이 페이지에 쓸 통합 시크릿을 넣어 주세요",
  "bad-token": "노션이 시크릿을 받지 않았어요. 통합의 시크릿을 다시 복사해 주세요",
  "not-found": "페이지를 찾지 못했어요. 페이지의 ••• → 연결에서 통합을 추가했는지 확인하세요",
  "not-a-page": "데이터베이스가 아닌 일반 페이지를 골라 주세요",
  "no-write": "통합에 콘텐츠 삽입·업데이트 권한이 없어요",
  "rate-limited": "노션 요청이 많아요. 잠시 뒤 다시 시도해 주세요",
  unreachable: "노션에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요",
};

type Line = { tone: "busy" | "ok" | "error" | "muted"; text: string };

const LINE_STYLE: Record<Line["tone"], string> = {
  busy: "border-transparent",
  ok: "border-transparent",
  muted: "border-transparent",
  error: "border-[#d93025] text-[#d93025]",
};

function statusLine(status: NotionStatus | null): Line {
  if (!status) return { tone: "muted", text: "연결 상태를 읽는 중…" };
  if (!status.linked) return { tone: "muted", text: "연결된 노션 페이지가 없어요" };
  const name = status.title || "노션 페이지";
  const by = status.source === "env" ? "서버 기본 설정" : status.linkedByName || "팀원";
  if (status.pending) return { tone: "busy", text: `${name} · 저장 중…` };
  if (status.state === "failed") return { tone: "error", text: `${name} · 저장 실패${status.httpStatus ? ` (HTTP ${status.httpStatus})` : ""}` };
  return { tone: "ok", text: `${name} · 연결됨 (${by})` };
}

export function NotionLinkForm() {
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [page, setPage] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "verify" | "link" | "unlink">(null);
  const [result, setResult] = useState<NotionLinkResult | null>(null);

  const read = () =>
    api.getNotion().then(
      (s) => (setStatus(s), setUnreachable(false)),
      () => setUnreachable(true),
    );
  useEffect(() => {
    void read();
    const timer = setInterval(read, 10_000);
    return () => clearInterval(timer);
  }, []);

  async function run(kind: "verify" | "link") {
    setBusy(kind);
    try {
      const answer = await (kind === "verify" ? api.verifyNotion : api.linkNotion)(page.trim(), token.trim() || undefined);
      setResult(answer);
      if (answer.ok && answer.notion) {
        setStatus(answer.notion);
        setToken(""); // 저장된 뒤에는 화면에 남기지 않는다
      }
    } catch {
      setUnreachable(true);
    } finally {
      setBusy(null);
    }
  }

  async function unlink() {
    setBusy("unlink");
    try {
      setStatus(await api.unlinkNotion());
      setResult(null);
    } catch {
      setUnreachable(true);
    } finally {
      setBusy(null);
    }
  }

  const line: Line = busy
    ? { tone: "busy", text: busy === "unlink" ? "해제하는 중…" : "노션에 확인하는 중…" }
    : result && !result.ok && result.reason
      ? { tone: "error", text: REASON[result.reason] ?? "연결하지 못했어요" }
      : result?.ok && !result.notion && result.check
        ? { tone: "ok", text: `${result.check.title || "노션 페이지"} · 쓸 수 있어요. '연결'을 누르면 저장해요` }
        : unreachable
          ? { tone: "error", text: "로컬 수집기에 닿지 못했어요 · 수집기 연결을 확인해 주세요" }
          : statusLine(status);

  return (
    <section className="rounded-[14px] border border-[rgba(24,23,58,0.08)] bg-white p-5">
      <header className="flex items-start gap-3">
        <BookText className="mt-0.5 size-5 shrink-0 text-[#18173a]" />
        <div>
          <h2 className="text-base font-semibold text-[#18173a]">노션에 팀 기록 저장</h2>
          <p className="mt-0.5 text-sm text-muted-foreground break-keep">
            승인한 결정·할 일이 이 노션 페이지에 자동으로 정리돼요. 레포를 공개하고 싶지 않을 때 써요.
          </p>
        </div>
      </header>

      <div className="mt-4 grid gap-2">
        <input
          aria-label="노션 페이지 주소 또는 ID"
          placeholder="노션 페이지 주소 (••• → 링크 복사) 또는 ID"
          value={page}
          onChange={(e) => setPage(e.target.value)}
          className="h-10 rounded-[8px] border border-[rgba(24,23,58,0.16)] px-3 text-sm outline-none focus:border-[#18173a]"
        />
        <input
          aria-label="노션 통합 시크릿"
          type="password"
          autoComplete="off"
          placeholder={status?.source === "team" && status.tokenSet ? "통합 시크릿 (같은 페이지면 비워도 돼요)" : "노션 내부 통합 시크릿"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-10 rounded-[8px] border border-[rgba(24,23,58,0.16)] px-3 text-sm outline-none focus:border-[#18173a]"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!page.trim() || !!busy}
            onClick={() => void run("verify")}
            className="h-10 rounded-[8px] border border-[rgba(24,23,58,0.16)] px-4 text-[13px] font-medium text-[#18173a] disabled:opacity-50"
          >
            연결 확인
          </button>
          <button
            type="button"
            disabled={!page.trim() || !!busy}
            onClick={() => void run("link")}
            className="h-10 rounded-[8px] bg-[#18173a] px-4 text-[13px] font-medium text-white disabled:opacity-50"
          >
            연결
          </button>
        </div>
      </div>

      <p
        role="status"
        className={`mt-3 rounded-[8px] border bg-[rgba(239,229,214,0.5)] px-3 py-2 text-sm break-keep ${LINE_STYLE[line.tone]}`}
      >
        {line.text}
      </p>

      {status?.linked && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {status.savedAt ? `마지막 저장 ${fmtMDHM(new Date(status.savedAt * 1000))}` : "아직 저장 기록 없음"}
            {status.source === "env" && " · 서버 기본 페이지라 여기서 해제할 수 없어요"}
          </span>
          {status.source === "team" && (
            <button type="button" disabled={!!busy} onClick={() => void unlink()} className="underline underline-offset-2 disabled:opacity-50">
              연결 해제
            </button>
          )}
        </div>
      )}
    </section>
  );
}
