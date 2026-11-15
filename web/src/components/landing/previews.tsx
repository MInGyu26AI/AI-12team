// 첫 화면(피그마 1번 147:2) 섹션마다 오른쪽에 두는 제품 미리보기 목업. 실제 데이터가 아니라 그림이라 글자는 피그마 예시 그대로 둔다.
// 공통 모양: 흰 카드 · 테두리 rgba(24,23,58,0.1) · 모서리 16 · 그림자 0 1 2 / 0 8 24
import Image from "next/image";
import { ArrowUp, Check, Copy, Lock, Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";

const frame = "rounded-2xl border border-foreground/10 bg-white shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.06)]";
const hairline = "h-px bg-foreground/8";

// 작은 SyncUp 아이콘. 40px 로고(brand.tsx)와 같은 비율로 줄인다: 모서리 24% · 쉐브론 (26,10) 8×4 · S 글자
export function MiniMark({ size = 22 }: { size?: number }) {
  const k = size / 40;
  return (
    <span aria-hidden className="relative block shrink-0 bg-brand" style={{ width: size, height: size, borderRadius: 9.6 * k }}>
      <Image
        src="/brand/logo-chevron.svg"
        alt=""
        width={10.4 * k}
        height={6.4 * k}
        unoptimized
        className="absolute max-w-none"
        style={{ left: 24.8 * k, top: 8.8 * k, width: 10.4 * k, height: 6.4 * k }}
      />
      <span className="absolute left-0 block text-center font-bold text-white" style={{ top: 3.2 * k, width: 36 * k, fontSize: 28 * k, lineHeight: `${33.3 * k}px` }}>
        S
      </span>
    </span>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}

// Section 0 · 팀 결정 기록 (147:37)
const RECORD_ROWS = [
  { date: "11/7", topic: "역할·일정", title: "발표일은 목요일", by: "박지민의 ChatGPT · 충돌 해결" },
  { date: "11/6", topic: "작업·결과물", title: "MVP는 ChatGPT 웹만 지원", by: "이서준의 ChatGPT" },
  { date: "11/5", topic: "할 일", title: "PPT 초안 금요일까지 · 정하린", by: "정하린의 ChatGPT" },
  { date: "11/3", topic: "주제·목표", title: "서비스 이름은 SyncUp", by: "정하린의 ChatGPT" },
];
const FACES = [
  { c: "서", bg: "#cde9f4" },
  { c: "유", bg: "#eadfcf" },
  { c: "지", bg: "#e3dcf2" },
  { c: "하", bg: "#fff326" },
];

export function RecordPreview() {
  return (
    <div className={cn(frame, "w-full max-w-[520px] overflow-hidden")}>
      <div className="flex items-center justify-between px-6 py-5">
        <div className="space-y-1">
          <p className="text-[17px] font-medium">팀 결정 기록</p>
          <p className="text-xs text-text-tertiary">AI 해커톤 12팀 · 결정 5 · 할 일 6</p>
        </div>
        <span className="flex -space-x-1.5">
          {FACES.map((f) => (
            <span key={f.c} className="flex size-[26px] items-center justify-center rounded-full border-2 border-white text-[11px] font-medium" style={{ background: f.bg }}>
              {f.c}
            </span>
          ))}
        </span>
      </div>
      {RECORD_ROWS.map((r) => (
        <div key={r.title}>
          <div className={hairline} />
          <div className="flex gap-5 px-6 py-4">
            <span className="w-9 shrink-0 text-xs text-text-tertiary">{r.date}</span>
            <div className="min-w-0 space-y-1.5">
              <p className="text-xs text-text-tertiary">{r.topic}</p>
              <p className="text-base font-medium">{r.title}</p>
              <p className="text-xs text-text-tertiary">{r.by}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Section 1 · 승인함 (148:2)
const APPROVE_ROWS = [
  { on: true, dot: "#82c8e5", tag: "결정", title: "발표일은 목요일로 한다", by: "11/5 · 박지민의 ChatGPT" },
  { on: true, dot: "#d4ae00", tag: "할 일", title: "PPT 초안 금요일까지 · 정하린", by: "11/5 · 정하린의 ChatGPT" },
  { on: false, dot: "#16a34a", tag: "조사", title: "국내 팀플 협업 툴 사례 3건", by: "11/6 · 이서준의 ChatGPT" },
];

export function ApprovePreview() {
  return (
    <div className={cn(frame, "w-full max-w-[520px] overflow-hidden")}>
      <div className="flex items-center justify-between px-6 py-5">
        <p className="text-[17px] font-medium">승인함</p>
        <p className="text-xs text-text-tertiary">ChatGPT에서 모은 후보 4개</p>
      </div>
      {APPROVE_ROWS.map((r) => (
        <div key={r.title}>
          <div className={hairline} />
          <div className="flex gap-4 px-6 py-4">
            <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md", r.on ? "bg-brand text-white" : "border border-foreground/25 bg-white")}>
              {r.on && <Check className="size-3.5" strokeWidth={2.5} />}
            </span>
            <div className="min-w-0 space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Dot color={r.dot} />
                {r.tag}
              </p>
              <p className="text-base font-medium">{r.title}</p>
              <p className="text-xs text-text-tertiary">{r.by}</p>
            </div>
          </div>
        </div>
      ))}
      <div className={hairline} />
      <div className="flex items-center justify-between border-b border-dashed border-foreground/10 px-6 py-3.5">
        <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Lock className="size-4" />
          개인 · 토익 시험 일정 질문
        </p>
        <span className="rounded-md bg-foreground/6 px-2 py-[3px] text-[11px] font-medium text-muted-foreground">팀에 공유 안 함</span>
      </div>
      <div className="space-y-3.5 px-6 py-5">
        <p className="text-xs text-text-tertiary">승인 전에도 연락처 같은 민감정보는 가려서 보여 줘요 · 010-****-****</p>
        <div className="flex h-11 items-center justify-center rounded-[10px] bg-brand text-base font-medium text-white">선택한 2개를 팀에 공유</div>
      </div>
    </div>
  );
}

// Section 2 · 대화 중 실시간 알림 (148:64): ChatGPT 창 위에 SyncUp 알림이 뜬 모습
export function AlertPreview() {
  return (
    <div className="relative w-full max-w-[560px] pt-16">
      <div className={cn(frame, "relative h-[380px] max-w-[520px] overflow-hidden")}>
        <div className="flex h-10 items-center border-b border-foreground/8 bg-[#e6d8c4]/50 px-5 text-xs text-text-tertiary">chatgpt.com</div>
        <div className="flex h-[340px]">
          <div className="w-[140px] shrink-0 space-y-2 border-r border-foreground/8 bg-[#e6d8c4]/30 px-2 py-4">
            <p className="px-2.5 text-sm font-medium">ChatGPT</p>
            <p className="px-2.5 pt-2 text-xs text-muted-foreground">새 채팅</p>
            <p className="px-2.5 pt-2 text-[11px] text-text-tertiary">오늘</p>
            <p className="rounded-lg bg-[#e6d8c4]/80 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap">팀 프로젝트 발표 준비</p>
            <p className="px-2.5 pt-1.5 text-xs text-muted-foreground">발표 자료 구성</p>
            <p className="px-2.5 text-xs text-muted-foreground">역할 분담 정리</p>
          </div>
          <div className="min-w-0 flex-1 space-y-6 p-6 pt-[108px]">
            <p className="ml-auto w-fit rounded-[14px] bg-[#e6d8c4]/80 px-3.5 py-2.5 text-[13px]">발표는 금요일로 정했어. 일정 정리해 줘</p>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p className="text-[13px] font-medium text-foreground">금요일 발표를 기준으로 정리할게요</p>
              <p>·&nbsp; 수요일&nbsp; 자료 정리</p>
              <p>·&nbsp; 목요일&nbsp; 리허설</p>
              <p>·&nbsp; 금요일&nbsp; 발표</p>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute top-0 right-0 w-[268px] space-y-2.5 rounded-[14px] border border-foreground/10 bg-white px-[18px] py-4 shadow-[0_12px_32px_rgb(0_0_0/0.1)]">
        <p className="flex items-center gap-2.5 text-xs text-text-tertiary">
          <MiniMark />
          SyncUp · 지금
        </p>
        <p className="text-[15px] font-medium">발표일이 기존 결정과 달라요</p>
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground">기존 결정&nbsp; 목요일 · 박지민</p>
          <p className="flex items-center gap-1.5 font-medium">
            <Dot color="#d93025" />
            이 대화&nbsp; 금요일 · 이서준
          </p>
        </div>
        <span className="inline-flex h-8 items-center rounded-[10px] border border-foreground/10 px-3.5 text-sm font-medium">결정 확인</span>
      </div>
      <p className="mt-3 text-[10px] text-text-tertiary">ChatGPT는 OpenAI의 상표이며, SyncUp은 OpenAI와 제휴 관계가 없습니다</p>
    </div>
  );
}

// Section 3 · 결정 충돌 해결 (149:2)
export function ConflictPreview() {
  return (
    <div className={cn(frame, "w-full max-w-[520px] overflow-hidden")}>
      <div className="space-y-2 px-6 py-[22px]">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Dot color="#d93025" />
          결정 충돌 · 역할·일정
        </p>
        <p className="text-[19px] font-medium">발표일이 기존 결정과 달라요</p>
      </div>
      <div className="flex items-center gap-3 px-6 pb-5">
        <div className="min-w-0 flex-1 space-y-1.5 rounded-[12px] bg-[#e6d8c4]/50 p-4">
          <p className="text-xs text-muted-foreground">기존 결정</p>
          <p className="text-[22px] font-medium">목요일</p>
          <p className="text-xs text-muted-foreground">박지민 · 11/5 팀 승인</p>
        </div>
        <span className="text-xs text-text-tertiary">vs</span>
        <div className="min-w-0 flex-1 space-y-1.5 rounded-[12px] border border-card-border bg-white p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Dot color="#d93025" />
            이 대화에서
          </p>
          <p className="text-[22px] font-medium">금요일</p>
          <p className="text-xs text-text-tertiary">이서준 · 11/7 ChatGPT</p>
        </div>
      </div>
      <div className={hairline} />
      <div className="flex gap-3 px-6 py-5">
        <span className="flex h-11 flex-1 items-center justify-center rounded-[10px] border border-foreground/10 text-base font-medium">기존 결정 유지</span>
        <span className="flex h-11 flex-1 items-center justify-center rounded-[10px] bg-brand text-base font-medium text-white">금요일로 변경</span>
      </div>
    </div>
  );
}

// Section 4 · 새 대화에 붙여넣기 (149:41)
export function PastePreview() {
  return (
    <div className="relative w-full max-w-[560px] pt-10">
      <div className={cn(frame, "relative h-[420px] max-w-[520px] overflow-hidden")}>
        <div className="flex h-10 items-center border-b border-foreground/8 bg-[#e6d8c4]/50 px-5 text-xs text-text-tertiary">chatgpt.com · 새 채팅</div>
        <div className="flex flex-col gap-8 p-6">
          <div className="ml-auto w-fit max-w-[80%] space-y-1.5 rounded-[14px] bg-[#e6d8c4]/80 px-4 py-3.5">
            <div className="space-y-1 rounded-lg border border-foreground/8 bg-white px-3 py-2.5 text-xs">
              <p className="text-[11px] font-medium text-muted-foreground">SyncUp 팀 기록 · AI 해커톤 12팀</p>
              <p className="flex gap-2">
                <span className="text-muted-foreground">·&nbsp; 서비스 이름</span>
                <b className="font-medium">SyncUp</b>
              </p>
              <p className="flex gap-2">
                <span className="text-muted-foreground">·&nbsp; 발표일</span>
                <b className="font-medium">목요일</b>
              </p>
              <p className="flex gap-2">
                <span className="text-muted-foreground">·&nbsp; MVP</span>
                <b className="font-medium">ChatGPT 웹만 지원</b>
              </p>
            </div>
            <p className="text-[13px]">이 기준으로 발표 대본 초안 써 줘</p>
          </div>
          <div className="space-y-2">
            <p className="text-[13px] font-medium">팀 기록을 기준으로 정리할게요</p>
            <p className="text-xs leading-[1.6] text-muted-foreground break-keep">
              발표는 목요일, MVP 범위는 ChatGPT 웹이에요.
              <br />
              도입부에서 SyncUp이라는 이름의 뜻부터 소개해 볼게요.
            </p>
          </div>
        </div>
        <div className="absolute inset-x-6 bottom-5 flex h-11 items-center justify-between rounded-[12px] border border-foreground/12 bg-white px-4 text-[13px] text-text-tertiary">
          메시지 입력
          <ArrowUp className="size-4" />
        </div>
      </div>
      <div className="absolute top-0 right-0 flex items-center gap-2 rounded-[10px] bg-brand px-3.5 py-2.5 text-[13px] font-medium text-white shadow-[0_8px_20px_rgb(0_0_0/0.12)]">
        <Copy className="size-4" />
        SyncUp에서 팀 기록을 복사했어요
      </div>
    </div>
  );
}

// Section 5 · 확장 팝업 (248:42): 브라우저 창 위에 팝업이 열린 모습
export function PopupPreview() {
  return (
    <div className="relative w-full max-w-[536px] pt-10">
      <div className="h-[360px] overflow-hidden rounded-[14px] border border-foreground/8 bg-white">
        <div className="flex items-center gap-2.5 bg-brand-soft px-3.5 py-2.5">
          <span className="min-w-0 flex-1 rounded-lg bg-white px-3 py-1.5 text-xs text-muted-foreground">chatgpt.com</span>
          <Puzzle className="size-4 text-muted-foreground" />
          <MiniMark size={20} />
        </div>
        <div className="space-y-2.5 px-6 pt-6">
          <div className="h-2.5 w-[300px] max-w-full rounded-full bg-brand-soft" />
          <div className="h-2.5 w-[220px] max-w-full rounded-full bg-brand-soft" />
          <div className="h-2.5 w-[260px] max-w-full rounded-full bg-brand-soft" />
        </div>
      </div>
      <div className="absolute top-[84px] right-3 w-[260px] space-y-3 rounded-[14px] border border-foreground/10 bg-white px-[18px] py-4 shadow-[0_8px_24px_rgb(0_0_0/0.08)]">
        <p className="flex items-center gap-2 text-[15px] font-medium">
          <MiniMark />
          SyncUp
        </p>
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          <span aria-hidden className="size-[7px] rounded-full bg-ok" />
          연결됨 · AI 해커톤 12팀
        </p>
        <p className="text-xs text-muted-foreground">팀에는 내가 승인한 것만 올라가요</p>
        <div className="flex gap-2">
          <span className="flex h-8 items-center rounded-lg bg-brand px-3 text-xs font-medium text-white">싱크 맞추기</span>
          <span className="flex h-8 items-center rounded-lg border border-foreground/14 px-3 text-xs font-medium">승인함 보기</span>
        </div>
      </div>
    </div>
  );
}
