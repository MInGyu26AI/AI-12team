import { describe, expect, it } from 'vitest';
import type { CollectedMessage } from '@shared/collector';
import {
  EMPTY_BODIES_RATIO_WARN,
  FALLBACK_STRATEGIES,
  GUESSED_ROLES_RATIO_WARN,
  RATIO_MIN_MESSAGES,
  assessExtractHealth,
  formatExtractDiagnostic,
  summarizeExtract,
  type ExtractSummary,
} from '@/lib/extract-health';
import type { TabPingResult } from '@/lib/messages';

const summary = (changes: Partial<ExtractSummary> = {}): ExtractSummary => ({
  onConversation: true,
  messageCount: 6,
  selector: 'turn-attr',
  guessedRoles: 0,
  ...changes,
});
const codes = (s: ExtractSummary) => assessExtractHealth(s).reasons.map((r) => r.code);

describe('assessExtractHealth', () => {
  it('속성 기반 전략으로 잘 읽힌 대화 화면은 정상이다', () => {
    expect(assessExtractHealth(summary())).toEqual({ status: 'ok', reasons: [] });
    for (const selector of ['author-role', 'turn-attr', 'conversation-turn', 'message-id', 'search-unit']) {
      expect(codes(summary({ selector }))).toEqual([]);
    }
  });

  it('대화 화면이 아니면 0건이어도 정상이다 (읽을 대화가 없는 것)', () => {
    expect(assessExtractHealth(summary({ onConversation: false, messageCount: 0, selector: null }))).toEqual({ status: 'ok', reasons: [] });
  });

  it('대화 화면인데 0건이면 경고한다', () => {
    const health = assessExtractHealth(summary({ messageCount: 0, selector: null }));
    expect(health.status).toBe('warn');
    expect(health.reasons.map((r) => r.code)).toEqual(['no-messages']);
    expect(health.reasons[0]!.message).toContain('한 건도 읽지 못했어요');
  });

  it('뒤쪽(짐작) 전략으로 밀리면 경고한다', () => {
    expect(FALLBACK_STRATEGIES).toEqual(['article', 'content-blocks', 'repeated-blocks']);
    for (const selector of FALLBACK_STRATEGIES) expect(codes(summary({ selector }))).toEqual(['fallback-strategy']);
    // 모르는 전략 이름은 위치를 알 수 없으니 경고하지 않는다
    expect(codes(summary({ selector: 'brand-new-strategy' }))).toEqual([]);
  });

  it('화자 추정이 문턱 비율 이상이면 경고하고, 미만이면 정상이다', () => {
    expect(GUESSED_ROLES_RATIO_WARN).toBe(0.3);
    expect(codes(summary({ messageCount: 10, guessedRoles: 3 }))).toEqual(['many-guessed-roles']);
    expect(codes(summary({ messageCount: 10, guessedRoles: 2 }))).toEqual([]);
    expect(codes(summary({ messageCount: 10, guessedRoles: 10 }))).toEqual(['many-guessed-roles']);
  });

  it('메시지가 너무 적으면 비율을 보지 않는다 (1~2개 중 하나는 우연일 수 있다)', () => {
    expect(RATIO_MIN_MESSAGES).toBe(3);
    expect(codes(summary({ messageCount: 2, guessedRoles: 2 }))).toEqual([]);
    expect(codes(summary({ messageCount: 3, guessedRoles: 1 }))).toEqual(['many-guessed-roles']);
  });

  it('빈 본문이 읽으려던 요소의 문턱 비율 이상이면 경고한다', () => {
    expect(EMPTY_BODIES_RATIO_WARN).toBe(0.3);
    expect(codes(summary({ messageCount: 7, emptyBodies: 3 }))).toEqual(['many-empty-bodies']); // 3/10
    expect(codes(summary({ messageCount: 8, emptyBodies: 2 }))).toEqual([]); // 2/10
  });

  it('대화 화면이고 읽은 메시지는 없는데 빈 요소만 많으면 둘 다 알린다', () => {
    expect(codes(summary({ messageCount: 0, selector: null, emptyBodies: 4 }))).toEqual(['no-messages', 'many-empty-bodies']);
  });

  it('빈 본문 수를 모르면(생략) 0 으로 본다', () => {
    expect(codes(summary({ emptyBodies: undefined }))).toEqual([]);
  });

  it('여러 이유가 겹치면 모두 돌려준다', () => {
    expect(codes(summary({ selector: 'content-blocks', messageCount: 10, guessedRoles: 5, emptyBodies: 5 }))).toEqual([
      'fallback-strategy',
      'many-guessed-roles',
      'many-empty-bodies',
    ]);
  });

  it('깨진 숫자(NaN · 음수)에도 던지지 않는다', () => {
    expect(() => assessExtractHealth(summary({ messageCount: Number.NaN, guessedRoles: -1, emptyBodies: Number.NaN }))).not.toThrow();
    expect(codes(summary({ messageCount: Number.NaN, selector: null }))).toEqual(['no-messages']);
  });

  it('팝업이 받는 TabPingResult 를 그대로 넣을 수 있다', () => {
    const ping: TabPingResult = { site: 'ChatGPT', onConversation: true, messageCount: 0, selector: null, guessedRoles: 0 };
    expect(assessExtractHealth(ping).reasons.map((r) => r.code)).toEqual(['no-messages']);
  });
});

describe('summarizeExtract', () => {
  const message: CollectedMessage = {
    id: 'chatgpt:m1',
    site: 'chatgpt',
    role: 'user',
    text: '비밀 문장: 우리 팀 결제 키는 sk-live-1234',
    conversationId: 'c1',
    conversationTitle: '비밀 제목',
    url: 'https://chatgpt.com/c/c1',
    collectedAt: '2026-11-13T00:00:00.000Z',
  };

  it('ExtractResult 에서 개수·전략만 뽑는다', () => {
    const tried = [
      { name: 'author-role', count: 0 },
      { name: 'turn-attr', count: 2 },
    ];
    expect(summarizeExtract(true, { messages: [message, message], selector: 'turn-attr', tried, guessedRoles: 1 }, 0)).toEqual({
      onConversation: true,
      messageCount: 2,
      selector: 'turn-attr',
      guessedRoles: 1,
      emptyBodies: 0,
      tried,
    });
  });

  it('요약에는 메시지 글 · 제목 · 주소가 들어가지 않는다', () => {
    const json = JSON.stringify(summarizeExtract(true, { messages: [message], selector: 'turn-attr', tried: [], guessedRoles: 0 }));
    for (const secret of ['비밀', 'sk-live', 'chatgpt.com/c/', 'm1']) expect(json).not.toContain(secret);
  });
});

describe('formatExtractDiagnostic', () => {
  it('전략별 개수와 판정을 담는다', () => {
    const text = formatExtractDiagnostic(
      summary({
        messageCount: 0,
        selector: null,
        tried: [
          { name: 'author-role', count: 0 },
          { name: 'turn-attr', count: 0 },
          { name: 'repeated-blocks', count: 0 },
        ],
      }),
    );
    expect(text).toContain('대화 화면: 예');
    expect(text).toContain('읽은 메시지: 0개');
    expect(text).toContain('먹힌 전략: 없음');
    expect(text).toContain('전략별 개수: author-role=0, turn-attr=0, repeated-blocks=0');
    expect(text).toContain('판정: 주의 (no-messages)');
  });

  it('정상이면 정상으로, 빈 본문 수를 모르면 알 수 없음으로 적는다', () => {
    const text = formatExtractDiagnostic(summary({ tried: [{ name: 'turn-attr', count: 6 }] }));
    expect(text).toContain('판정: 정상');
    expect(text).toContain('빈 본문: 알 수 없음');
    expect(text).toContain('먹힌 전략: turn-attr');
  });

  it('전략 이름 자리에 글이 들어와도 새지 않고 개수는 정수로만 적는다', () => {
    const text = formatExtractDiagnostic(
      summary({
        selector: '우리 팀 결제 키는 sk-live-1234',
        tried: [
          { name: '비밀 문장입니다', count: 3.9 },
          { name: 'x'.repeat(200), count: Number.NaN },
        ],
      }),
    );
    expect(text).not.toContain('비밀');
    expect(text).not.toContain('결제');
    expect(text).not.toContain('x'.repeat(41));
    expect(text).toContain('?????=3');
  });

  it('전략 기록이 없으면 그렇다고 적는다', () => {
    expect(formatExtractDiagnostic(summary())).toContain('전략별 개수: (기록 없음)');
  });
});
