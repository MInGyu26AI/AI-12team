// 목업 모드 전용 충돌 판정 (web/src/lib/api/mock.ts). 실제 판정은 팀 서버가 하은 님 AI(Decisions → chat → 규칙)로 한다.
// ai/syncup_ai/conflict.py 의 rule_judge·find_candidates 를 본뜬 근사이고, 두 구현을 같은 사례로 검사하지는 않는다.
import type { Conflict, Judgement, RelatedCard } from "./types";

const CONFLICT_TOP_K = 3; // 목업 후보 제한. 실제 서버의 AI 호출당 비교 수와 별개.
const CONFLICT_ON_CHANGE = true; // config.CONFLICT_ON_CHANGE — '변경'도 경고로 (11/7 팀 결정)
const ALERT_JUDGEMENTS: Judgement[] = CONFLICT_ON_CHANGE ? ["충돌", "변경"] : ["충돌"];

interface PairJudgement {
  id: string; // 기존 카드 id
  judgement: Judgement;
  reason: string;
  confidence: number;
}

const isDecision = (c: RelatedCard) => c.relevance === "related" && c.tag === "decision";
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const TEAM_AGREED = /팀에서|다들|모두|합의|회의에서/;

/** 같은 세부 주제의 기존 결정 (최근 것부터 상위 CONFLICT_TOP_K 개). 유사도 후보는 AI 쪽에서 */
function findCandidates(next: RelatedCard, existing: RelatedCard[]): RelatedCard[] {
  return existing
    .filter((c) => isDecision(c) && c.id !== next.id && !!next.topic_key && c.topic_key === next.topic_key)
    .slice(-CONFLICT_TOP_K)
    .reverse();
}

function ruleJudge(next: RelatedCard, old: RelatedCard): PairJudgement {
  if (next.topic_key !== old.topic_key) return { id: old.id, judgement: "무관", reason: "세부 주제가 다름", confidence: 0.4 };
  if (norm(next.content) === norm(old.content))
    return { id: old.id, judgement: "같음", reason: "같은 세부 주제의 같은 내용", confidence: 0.6 };
  // 정답표: 같은 사람이 고치거나 팀 합의로 바꾸면 변경, 다른 사람이 반대로 정하면 충돌
  const sameOwner = !!next.owner && next.owner === old.owner;
  const teamAgreed = TEAM_AGREED.test(next.sentence);
  const judgement: Judgement = sameOwner || teamAgreed ? "변경" : "충돌";
  const reason =
    judgement === "변경"
      ? `같은 세부 주제(${old.topic_key})의 기존 결정 '${old.content}'을(를) 바꾸는 표현: '${next.content}'`
      : `같은 세부 주제(${old.topic_key})의 기존 결정 '${old.content}'과(와) 다른 내용: '${next.content}'`;
  return { id: old.id, judgement, reason, confidence: 0.5 };
}

/** 새 결정 하나 → 경고할 Conflict 목록 (cardA = 기존, cardB = 새 결정) */
function checkNewDecision(next: RelatedCard, existing: RelatedCard[]): Conflict[] {
  if (!isDecision(next)) return [];
  return findCandidates(next, existing)
    .map((old) => ({ old, r: ruleJudge(next, old) }))
    .filter(({ r }) => ALERT_JUDGEMENTS.includes(r.judgement))
    .map(({ old, r }) => ({
      id: `${old.id}__${next.id}`,
      topic_key: old.topic_key ?? next.topic_key ?? "",
      cardA: old,
      cardB: next,
      judgement: r.judgement,
      reason: r.reason,
      confidence: r.confidence,
    }));
}

/** 여러 장을 한꺼번에 승인할 때: 앞 카드가 다음 카드의 '기존'이 된다 (handle_request 와 같음) */
export function checkNewCards(newCards: RelatedCard[], existing: RelatedCard[]): Conflict[] {
  const pool = [...existing];
  const out: Conflict[] = [];
  for (const c of newCards) {
    out.push(...checkNewDecision(c, pool));
    pool.push(c);
  }
  return out;
}
