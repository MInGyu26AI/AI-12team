"use client";

import { useMemo, useState } from "react";
import { MessageCircle, Sparkles } from "lucide-react";
import { formatSource, ymd } from "@shared/format";
import {
  defaultRole,
  kakaoSelection,
  parseKakao,
  type KakaoMode,
  type KakaoParse,
  type KakaoRole,
  type KakaoRoom,
} from "@shared/kakaotalk";
import { parsePasted, type Utterance } from "@shared/utterance";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { USE_MOCK } from "@/lib/api";
import { useLocal } from "@/lib/browser-store";

// 시연용 예시 대화: 목업 팀 '온길'(하은 님 합성 대화 H01, shared/mock.ts)에서 보드에 아직 없는 문장. 이름·연락처는 가짜.
// 목업 모드에서만 넣을 수 있다 (실제 모드에선 진짜 입력이 된다).
// 단톡방 줄의 할 일(담당 = 채원) · 전화번호 가림 · AI 답변 · 제안 · 개인 2줄
const SAMPLE = `나: 이거 우리 단톡방 내용이야.
[도윤] 발표 슬라이드 초안은 채원이가 일요일까지 만들어 줘. 급하면 010-3141-5926으로 연락해.
ChatGPT: 실외까지 넣으면 GPS 오차 처리가 추가로 필요해요.
[채원] QR 대신 NFC 태그는 어때?
[하준] 나 금요일에 치과 예약 있어서 저녁 회의 못 가.
[채원] 요즘 잠을 너무 못 자서 컨디션이 엉망이야.`;

// 목업 팀 '온길'(shared/mock.ts, 나 = 김도윤)의 카톡 단톡방. 이름은 가짜. 사진 줄과 입장 알림은 빠지고,
// '내 글만'이면 김도윤 메시지만, '팀 전체'면 팀원 메시지도 이름을 붙여 보낸다 (하준 님 개인 사정 줄은 분류에서 개인)
const KAKAO_SAMPLE = `온길 님과 카카오톡 대화
저장한 날짜 : 2026-11-14 22:10
--------------- 2026년 11월 14일 금요일 ---------------
윤채원님이 들어왔습니다.
[김도윤] [오후 9:02] 시연 영상은 3분 이내로 하자
[윤채원] [오후 9:03] 좋아. 자막은 내가 일요일까지 넣을게
[서하준] [오후 9:05] 나 금요일에 치과 예약 있어서 저녁 회의 못 가
[김도윤] [오후 9:06] 사진
[김도윤] [오후 9:07] 발표 순서는 문제 정의 → 시연 → 팀 소개로 가자
그리고 질문 시간은 2분 남기자`;

// 이 브라우저에만 두는 카톡 방 목록 (방 키·화자 역할·'팀 전체' 확인). 수집기로는 방 키만 간다
const ROOMS_KEY = "syncup:kakao-rooms:v1";
const NEW_ROOM = "new";

const MODE_OPTIONS: { value: KakaoMode; label: string }[] = [
  { value: "mine", label: "내 글만" },
  { value: "team", label: "팀 전체" },
];
type RoleKind = KakaoRole["kind"];
const ROLE_OPTIONS: { value: RoleKind; label: string }[] = [
  { value: "me", label: "나" },
  { value: "member", label: "팀원" },
  { value: "skip", label: "빼기" },
];

interface PasteProps {
  busy: boolean;
  onClassify: (u: Utterance[]) => void;
  me?: string; // 내 SyncUp 이름. 카톡 화자 이름과 같으면 '나'로 미리 고른다
  knownNames?: string[];
  teamName?: string;
}

export function PasteInput({ busy, onClassify, me = "", knownNames = [], teamName = "" }: PasteProps) {
  const [text, setText] = useState("");
  const kakao = useMemo(() => parseKakao(text), [text]);
  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={
          "AI와 나눈 대화나 카카오톡 대화를 붙여넣으세요.\n줄 앞에 '나:' 또는 'ChatGPT:'가 있으면 누가 말했는지 구분해요.\n카톡 대화는 알아서 메시지로 나누고, 사진·파일 줄은 빼요."
        }
        className="bg-background"
      />
      {USE_MOCK && (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => setText(SAMPLE)}>
            예시 대화 넣기
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setText(KAKAO_SAMPLE)}>
            예시 카톡 넣기
          </Button>
        </div>
      )}
      {kakao ? (
        <KakaoPanel parsed={kakao} busy={busy} onClassify={onClassify} me={me} knownNames={knownNames} teamName={teamName} />
      ) : (
        <div className="flex justify-end">
          <Button
            className="bg-brand hover:bg-brand-hover"
            disabled={!text.trim() || busy}
            onClick={() => onClassify(parsePasted(text, formatSource("ChatGPT")))}
          >
            <Sparkles />
            {busy ? "분류 중…" : "분류하기"}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        선택한 발화는 로컬 수집기를 통해 AI 분류에 보내요. 팀에는 내가 승인한 카드만 올라가요.
      </p>
    </div>
  );
}

type PanelProps = Omit<PasteProps, "onClassify"> & { parsed: KakaoParse; onClassify: (u: Utterance[]) => void };

// 카톡 대화로 알아봤을 때: 방 고르기 → 화자 역할 → 모드(세그먼트) → 분류하기
function KakaoPanel({ parsed, busy, onClassify, me = "", knownNames = [], teamName = "" }: PanelProps) {
  const [rooms, setRooms] = useLocal<KakaoRoom[]>(ROOMS_KEY, []);
  const teamRooms = rooms.filter((r) => r.team === teamName);
  const matched = teamRooms.find((r) => parsed.roomName && r.name === parsed.roomName);
  const [picked, setPicked] = useState<string | null>(null);
  const roomKey = picked ?? matched?.key ?? NEW_ROOM;
  const room = teamRooms.find((r) => r.key === roomKey) ?? null;
  const { attachments, system, unreadable } = parsed.skipped;
  const undated = parsed.messages.some((m) => !m.dated);
  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <MessageCircle className="size-4 text-brand" />
          카카오톡 대화로 알아봤어요 · 메시지 {parsed.messages.length}개 · {parsed.speakers.length}명
        </p>
        {(attachments > 0 || system > 0 || unreadable > 0 || undated) && (
          <p className="text-xs text-muted-foreground break-keep">
            {[
              attachments > 0 && `사진·동영상·파일 ${attachments}개는 가져오지 않아요`,
              system > 0 && `입장·삭제 같은 알림 ${system}줄은 뺐어요`,
              unreadable > 0 && `읽지 못한 줄 ${unreadable}개는 뺐어요`,
              undated && "날짜 줄이 없는 메시지는 오늘 날짜로 넣어요",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-14 shrink-0 text-muted-foreground">방</span>
        <select
          aria-label="카톡 방"
          value={roomKey}
          onChange={(e) => setPicked(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value={NEW_ROOM}>새 방으로 저장</option>
          {teamRooms.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <RoomForm
        key={roomKey}
        parsed={parsed}
        room={room}
        busy={busy}
        me={me}
        knownNames={knownNames}
        onSend={(next, utterances) => {
          setRooms([...rooms.filter((r) => r.key !== next.key), { ...next, team: teamName }]);
          setPicked(next.key);
          onClassify(utterances);
        }}
      />
    </div>
  );
}

function RoomForm({
  parsed,
  room,
  busy,
  me,
  knownNames,
  onSend,
}: {
  parsed: KakaoParse;
  room: KakaoRoom | null;
  busy: boolean;
  me: string;
  knownNames: string[];
  onSend: (room: KakaoRoom, utterances: Utterance[]) => void;
}) {
  const [key] = useState(() => room?.key ?? crypto.randomUUID());
  const [name, setName] = useState(room?.name ?? parsed.roomName ?? `카톡 방 ${ymd(new Date())}`);
  // 이번에 고친 역할만 상태로 둔다. 나머지는 방에 저장된 역할, 처음 보는 화자는 기본 역할 (다른 대화를 새로 붙여 넣어도 맞게)
  const [edits, setRoles] = useState<Record<string, KakaoRole>>({});
  const roles: Record<string, KakaoRole> = { ...room?.roles };
  for (const s of parsed.speakers) roles[s.name] = edits[s.name] ?? room?.roles[s.name] ?? defaultRole(s.name, me, knownNames);
  const [mode, setMode] = useState<KakaoMode>("mine");
  const [confirmed, setConfirmed] = useState(room?.teamConfirmed ?? false);
  const draft: KakaoRoom = { key, name: name.trim() || "카톡 방", team: room?.team ?? "", roles, teamConfirmed: confirmed };
  const selection = kakaoSelection(parsed, draft, mode);
  const hasMe = parsed.speakers.some((s) => roles[s.name]?.kind === "me");
  const setRole = (speaker: string, kind: RoleKind) => {
    const was = roles[speaker];
    const role: KakaoRole = kind === "member" ? { kind, name: was?.kind === "member" ? was.name : speaker } : { kind };
    setRoles((prev) => ({ ...prev, [speaker]: role }));
  };
  const blocked = !hasMe ? "'나'를 한 명 골라 주세요" : mode === "team" && !confirmed ? "팀 전체로 보내려면 위 확인에 체크해 주세요" : null;
  return (
    <div className="space-y-4">
      {!room && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-14 shrink-0 text-muted-foreground">방 이름</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="새 방 이름"
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
          />
        </label>
      )}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-14 shrink-0 text-muted-foreground">보낼 글</span>
          <Segmented label="보낼 글" value={mode} options={MODE_OPTIONS} onChange={setMode} />
        </div>
        <p className="text-xs text-muted-foreground break-keep">
          {mode === "mine"
            ? "내가 쓴 메시지만 보내요. 다른 사람 메시지는 이 PC에도 저장하지 않아요."
            : "나와 '팀원'으로 고른 사람의 메시지를 보내요. 팀원 메시지는 이름을 붙여 보내고, 그 사람이 결정·할 일의 주인이 돼요. '빼기'로 둔 사람(교수·조교 등)의 메시지는 보내지 않아요."}
        </p>
      </div>
      <ul className="divide-y rounded-md border bg-background">
        {parsed.speakers.map((s) => {
          const role = roles[s.name] ?? { kind: "skip" };
          return (
            <li key={s.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {s.name} <span className="text-xs text-muted-foreground">· {s.count}개</span>
              </span>
              {mode === "team" && role.kind === "member" && (
                <input
                  aria-label={`${s.name}의 팀 이름`}
                  list="kakao-team-names"
                  value={role.name}
                  onChange={(e) => setRoles((prev) => ({ ...prev, [s.name]: { kind: "member", name: e.target.value } }))}
                  className="h-7 w-28 rounded-md border px-2 text-xs"
                />
              )}
              <Segmented size="sm" label={`${s.name}의 역할`} value={role.kind} options={ROLE_OPTIONS} onChange={(k) => setRole(s.name, k)} />
            </li>
          );
        })}
      </ul>
      <datalist id="kakao-team-names">
        {knownNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {mode === "team" && (
        <label className="flex items-start gap-2 text-xs break-keep">
          <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
          <span>
            팀원 메시지도 이 PC에서 개인정보 검사를 거친 뒤 외부 AI 분류로 가요. 단톡방 팀원에게 알렸어요.
            <span className="block text-muted-foreground">
              {"같은 방은 한 명만 '팀 전체'로 올려 주세요. 여럿이 올리면 같은 결정이 여러 번 올라가요."}
            </span>
          </span>
        </label>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {blocked ??
            `보낼 메시지 ${selection.mine + selection.members}개 (내 메시지 ${selection.mine}${mode === "team" ? ` · 팀원 ${selection.members}` : ""})` +
              (selection.first && selection.last ? ` · ${selection.first.replace("T", " ")} ~ ${selection.last.replace("T", " ")}` : "")}
        </p>
        <Button
          className="ml-auto bg-brand hover:bg-brand-hover"
          disabled={busy || !!blocked || !selection.utterances.length}
          onClick={() => onSend(draft, selection.utterances)}
        >
          <Sparkles />
          {busy ? "분류 중…" : "분류하기"}
        </Button>
      </div>
    </div>
  );
}
