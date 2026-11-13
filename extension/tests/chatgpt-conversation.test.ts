// 공용 대화 파서(shared/chatgpt-conversation.ts) 시험: 픽스처 두 쌍과 docs/sync-contract.md 6장 규칙을 하나씩
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SyncWindow } from '@shared/bridge';
import {
  normalizeConversation,
  turnsInWindows,
  type NormalizedTurn,
  type RawConversation,
  type RawMessage,
  type RawNode,
} from '@shared/chatgpt-conversation';

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/chatgpt/${name}`, import.meta.url)), 'utf8'));
const expectedOf = (name: string) => {
  const { _note, ...expected } = fixture(name);
  void _note;
  return expected;
};

// 시각: 2025-11-13T01:00:00Z = 1762995600
const T0 = 1762995600;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const message = (id: string, role: string, text: string, sec: number | null, extra: Partial<RawMessage> = {}): RawMessage => ({
  id,
  author: { role },
  recipient: 'all',
  create_time: sec,
  content: { content_type: 'text', parts: [text] },
  status: 'finished_successfully',
  end_turn: role === 'assistant' ? true : null,
  metadata: {},
  ...extra,
});

/** 메시지를 한 줄로 이은 대화 (current_node = 마지막) */
function chain(messages: RawMessage[], conv: Partial<RawConversation> = {}): RawConversation {
  const mapping: Record<string, RawNode> = {};
  messages.forEach((m, i) => {
    const id = m.id as string;
    mapping[id] = { id, parent: i ? (messages[i - 1]!.id as string) : null, children: i < messages.length - 1 ? [messages[i + 1]!.id as string] : [], message: m };
  });
  return { current_node: messages.at(-1)?.id, mapping, ...conv };
}

const texts = (conv: RawConversation) => normalizeConversation(conv).turns.flatMap((t) => t.messages.map((m) => m.text));
const ids = (conv: RawConversation) => normalizeConversation(conv).turns.flatMap((t) => t.messages.map((m) => m.id));

describe('픽스처', () => {
  it('conversation-basic.json → expected-basic.json', () => {
    expect(normalizeConversation(fixture('conversation-basic.json'))).toEqual(expectedOf('expected-basic.json'));
  });

  it('conversation-in-progress.json → expected-in-progress.json', () => {
    expect(normalizeConversation(fixture('conversation-in-progress.json'))).toEqual(expectedOf('expected-in-progress.json'));
  });

  it('생성 중인 마지막 턴은 turnsInWindows 가 뺀다 (턴 1만 남음)', () => {
    const { turns } = normalizeConversation(fixture('conversation-in-progress.json'));
    const windows: SyncWindow[] = [{ start: '2025-11-13T00:00:00.000Z', end: '2025-11-13T02:00:00.000Z' }];
    expect(turnsInWindows(turns, windows).map((t) => t.turnId)).toEqual(['p-u1']);
  });
});

describe('줄기', () => {
  it('current_node 에서 parent 를 따라 올라간 가지만 쓴다 (편집 전 가지는 빠짐)', () => {
    const conv = chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '새 답', T0 + 1)]);
    conv.mapping!.u1!.children = ['a1', 'a-old'];
    conv.mapping!['a-old'] = { id: 'a-old', parent: 'u1', children: [], message: message('a-old', 'assistant', '옛 가지', T0 + 2) };
    expect(ids(conv)).toEqual(['u1', 'a1']);
  });

  it('current_node 가 없으면 자식 없는 노드 가운데 create_time 이 가장 늦은 것을 끝점으로 쓴다', () => {
    const conv = chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '답 1', T0 + 1)]);
    conv.mapping!.u1!.children = ['a1', 'a2'];
    conv.mapping!.a2 = { id: 'a2', parent: 'u1', children: [], message: message('a2', 'assistant', '답 2', T0 + 5) };
    delete conv.current_node;
    expect(ids(conv)).toEqual(['u1', 'a2']);
  });

  it('연결이 돌면 Error', () => {
    const conv = chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '답', T0 + 1)]);
    conv.mapping!.u1!.parent = 'a1';
    expect(() => normalizeConversation(conv)).toThrow(Error);
  });

  it('mapping 이 비어 있으면 턴도 없고 inProgress 도 false', () => {
    expect(normalizeConversation({ mapping: {} })).toEqual({ turns: [], inProgress: false });
    expect(normalizeConversation({})).toEqual({ turns: [], inProgress: false });
  });
});

describe('빼는 메시지', () => {
  const withMiddle = (middle: RawMessage) =>
    chain([message('u1', 'user', '질문', T0), middle, message('a1', 'assistant', '답', T0 + 3)]);

  it.each(['system', 'tool'])('역할이 %s 이면 뺀다', (role) => {
    expect(ids(withMiddle(message('x', role, '내용', T0 + 1)))).toEqual(['u1', 'a1']);
  });

  it('recipient 가 all 이 아닌 문자열이면 뺀다 (도구에 보내는 말)', () => {
    expect(ids(withMiddle(message('x', 'assistant', '검색어', T0 + 1, { recipient: 'browser' })))).toEqual(['u1', 'a1']);
    expect(ids(withMiddle(message('x', 'assistant', '코드', T0 + 1, { recipient: 'python' })))).toEqual(['u1', 'a1']);
  });

  it('recipient 가 null 이거나 all 이거나 아예 없으면 둔다', () => {
    expect(ids(withMiddle(message('x', 'assistant', '널', T0 + 1, { recipient: null })))).toEqual(['u1', 'x', 'a1']);
    expect(ids(withMiddle(message('x', 'assistant', '전체', T0 + 1, { recipient: 'all' })))).toEqual(['u1', 'x', 'a1']);
    const none = message('x', 'assistant', '없음', T0 + 1);
    delete none.recipient;
    expect(ids(withMiddle(none))).toEqual(['u1', 'x', 'a1']);
  });

  it.each([
    'code',
    'execution_output',
    'tether_browsing_display',
    'tether_quote',
    'user_editable_context',
    'model_editable_context',
    'thoughts',
    'reasoning_recap',
  ])('content_type 이 %s 이면 뺀다', (contentType) => {
    const m = message('x', 'assistant', '본문이 있어도', T0 + 1, { content: { content_type: contentType, parts: ['본문이 있어도'] } });
    expect(ids(withMiddle(m))).toEqual(['u1', 'a1']);
  });

  it('숨김·생각 머리말 표시가 있으면 뺀다', () => {
    const hidden = message('x', 'assistant', '숨김', T0 + 1, { metadata: { is_visually_hidden_from_conversation: true } });
    const preamble = message('y', 'assistant', '머리말', T0 + 1, { metadata: { is_thinking_preamble_message: true } });
    expect(ids(withMiddle(hidden))).toEqual(['u1', 'a1']);
    expect(ids(withMiddle(preamble))).toEqual(['u1', 'a1']);
  });

  it('표시가 거짓이면 둔다', () => {
    const m = message('x', 'assistant', '보임', T0 + 1, { metadata: { is_visually_hidden_from_conversation: false } });
    expect(ids(withMiddle(m))).toEqual(['u1', 'x', 'a1']);
  });

  it('본문이 공백뿐이면 역할 상관없이 뺀다', () => {
    const blankAssistant = message('x', 'assistant', ' \n ', T0 + 1);
    expect(ids(withMiddle(blankAssistant))).toEqual(['u1', 'a1']);
    const conv = chain([message('u0', 'user', '   ', T0), message('u1', 'user', '질문', T0 + 1), message('a1', 'assistant', '답', T0 + 2)]);
    expect(ids(conv)).toEqual(['u1', 'a1']);
  });

  it('message 가 없는 노드(root)는 건너뛴다', () => {
    const conv = chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '답', T0 + 1)]);
    conv.mapping!.root = { id: 'root', parent: null, children: ['u1'], message: null };
    conv.mapping!.u1!.parent = 'root';
    expect(ids(conv)).toEqual(['u1', 'a1']);
  });
});

describe('본문', () => {
  const single = (m: RawMessage) => texts(chain([m, message('a', 'assistant', '답', (m.create_time ?? T0) + 1)]))[0];

  it('문자열 part 를 \\n 으로 잇는다', () => {
    const m = message('u', 'user', '', T0, { content: { content_type: 'text', parts: ['첫 줄', '둘째 줄'] } });
    expect(single(m)).toBe('첫 줄\n둘째 줄');
  });

  it('첨부만 있는 메시지는 "[첨부 N개]" 한 줄이 된다 (사용자 메시지도 둔다)', () => {
    const m = message('u', 'user', '', T0, {
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer' }, { content_type: 'file' }] },
    });
    expect(single(m)).toBe('[첨부 2개]');
  });

  it('글과 첨부가 같이 있으면 맨 앞에 첨부 줄을 둔다', () => {
    const m = message('u', 'user', '', T0, {
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer' }, '이 표 정리해 줘'] },
    });
    expect(single(m)).toBe('[첨부 1개]\n이 표 정리해 줘');
  });

  it('multimodal_text 의 음성 전사는 글로 넣고 첨부로 세지 않는다', () => {
    const m = message('u', 'user', '', T0, {
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'audio_transcription', text: '음성으로 한 말' }, '덧붙임'] },
    });
    expect(single(m)).toBe('음성으로 한 말\n덧붙임');
  });

  it('multimodal_text 가 아니면 음성 전사 part 도 첨부로 센다', () => {
    const m = message('u', 'user', '', T0, {
      content: { content_type: 'text', parts: [{ content_type: 'audio_transcription', text: '말' }, '글'] },
    });
    expect(single(m)).toBe('[첨부 1개]\n글');
  });

  it('본문이 비면 model_dil_v2.fallbackMarkdown 을 쓴다', () => {
    const m = message('a', 'assistant', '', T0 + 1, { metadata: { model_dil_v2: { fallbackMarkdown: '| 표 |\n|---|' } } });
    expect(texts(chain([message('u', 'user', '질문', T0), m]))).toEqual(['질문', '| 표 |\n|---|']);
  });

  it('본문이 있으면 fallbackMarkdown 은 쓰지 않는다', () => {
    const m = message('a', 'assistant', '본문', T0 + 1, { metadata: { model_dil_v2: { fallbackMarkdown: '대체' } } });
    expect(texts(chain([message('u', 'user', '질문', T0), m]))).toEqual(['질문', '본문']);
  });

  it('fallbackMarkdown 도 비어 있으면 그 메시지를 뺀다', () => {
    const m = message('a', 'assistant', '', T0 + 1, { metadata: { model_dil_v2: { fallbackMarkdown: '  ' } } });
    expect(texts(chain([message('u', 'user', '질문', T0), m]))).toEqual(['질문']);
  });

  it('content_references 의 matched_text 를 모두 지우고 앞뒤 공백을 다듬는다', () => {
    const m = message('a', 'assistant', '  금요일로 합시다 【3†source】 그리고 월요일 【4†source】【3†source】 ', T0 + 1, {
      metadata: { content_references: [{ matched_text: '【3†source】' }, { matched_text: '【4†source】' }, { matched_text: '' }, {}] },
    });
    expect(texts(chain([message('u', 'user', '질문', T0), m]))[1]).toBe('금요일로 합시다  그리고 월요일');
  });

  it('인용 표시만 있는 답변은 지운 뒤 비므로 뺀다', () => {
    const m = message('a', 'assistant', '【1†source】', T0 + 1, { metadata: { content_references: [{ matched_text: '【1†source】' }] } });
    expect(texts(chain([message('u', 'user', '질문', T0), m]))).toEqual(['질문']);
  });

  it('fallbackMarkdown 의 인용 표시도 지운다', () => {
    const m = message('a', 'assistant', '', T0 + 1, {
      metadata: { model_dil_v2: { fallbackMarkdown: '요약 ⟦ref⟧' }, content_references: [{ matched_text: '⟦ref⟧' }] },
    });
    expect(texts(chain([message('u', 'user', '질문', T0), m]))[1]).toBe('요약');
  });
});

describe('턴', () => {
  it('사용자 메시지마다 새 턴을 열고 turnId 는 그 사용자 메시지 id 다', () => {
    const conv = chain([
      message('u1', 'user', '질문 1', T0),
      message('a1', 'assistant', '답 1', T0 + 1),
      message('u2', 'user', '질문 2', T0 + 10),
      message('a2', 'assistant', '답 2', T0 + 11),
    ]);
    const { turns } = normalizeConversation(conv);
    expect(turns.map((t) => [t.turnId, t.messages.map((m) => m.id)])).toEqual([
      ['u1', ['u1', 'a1']],
      ['u2', ['u2', 'a2']],
    ]);
  });

  it('답변 노드가 여러 개여도 합치지 않는다', () => {
    const conv = chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '답 1', T0 + 1, { end_turn: false }), message('a2', 'assistant', '답 2', T0 + 2)]);
    expect(normalizeConversation(conv).turns[0]!.messages.map((m) => m.text)).toEqual(['질문', '답 1', '답 2']);
  });

  it('첫 사용자 메시지 앞의 답변은 첫 답변 id 를 turnId 로 하는 턴으로 묶는다', () => {
    const conv = chain([
      message('a0', 'assistant', '환영해요', T0),
      message('a0b', 'assistant', '무엇을 도울까요?', T0 + 1),
      message('u1', 'user', '질문', T0 + 5),
      message('a1', 'assistant', '답', T0 + 6),
    ]);
    const { turns } = normalizeConversation(conv);
    expect(turns.map((t) => [t.turnId, t.messages.map((m) => m.id)])).toEqual([
      ['a0', ['a0', 'a0b']],
      ['u1', ['u1', 'a1']],
    ]);
  });

  it('message.id 가 없으면 노드 id 를 쓴다', () => {
    const conv = chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '답', T0 + 1)]);
    delete conv.mapping!.u1!.message!.id;
    expect(ids(conv)).toEqual(['u1', 'a1']);
  });
});

describe('완료', () => {
  const lastAnswer = (extra: Partial<RawMessage>) =>
    normalizeConversation(chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '답', T0 + 1, { end_turn: null, ...extra })]));

  it('metadata.is_complete === true 면 완료', () => {
    expect(lastAnswer({ metadata: { is_complete: true } }).turns[0]!.complete).toBe(true);
  });

  it('end_turn === true 면 완료', () => {
    expect(lastAnswer({ end_turn: true }).turns[0]!.complete).toBe(true);
  });

  it.each(['stop', 'interrupted', 'max_tokens'])('finish_details.type 이 %s 면 완료', (type) => {
    expect(lastAnswer({ metadata: { finish_details: { type } } }).turns[0]!.complete).toBe(true);
  });

  it('완료 표시가 하나도 없으면 미완료 (status 의 다른 값은 판단에 쓰지 않는다)', () => {
    expect(lastAnswer({ status: 'finished_successfully', metadata: {} }).turns[0]!.complete).toBe(false);
    expect(lastAnswer({ status: 'finished_successfully', metadata: { finish_details: { type: 'length' } } }).turns[0]!.complete).toBe(false);
  });

  it('완료 표시가 있으면 status 가 finished_partial_completion 이어도 완료', () => {
    expect(lastAnswer({ status: 'finished_partial_completion', metadata: { finish_details: { type: 'interrupted' } } }).turns[0]!.complete).toBe(true);
  });

  it('status 가 in_progress 면 다른 완료 표시가 있어도 미완료', () => {
    const result = lastAnswer({ status: 'in_progress', end_turn: true, metadata: { is_complete: true } });
    expect(result.turns[0]!.complete).toBe(false);
    expect(result.inProgress).toBe(true);
  });

  it('턴의 마지막 assistant 메시지로 판단한다 (앞 답변이 끝났어도 마지막이 안 끝났으면 미완료)', () => {
    const conv = chain([
      message('u1', 'user', '질문', T0),
      message('a1', 'assistant', '중간', T0 + 1, { end_turn: true }),
      message('a2', 'assistant', '이어서', T0 + 2, { end_turn: false }),
    ]);
    expect(normalizeConversation(conv).turns[0]!.complete).toBe(false);
  });

  it('답변이 없는 턴은 미완료', () => {
    const result = normalizeConversation(chain([message('u1', 'user', '질문', T0)]));
    expect(result.turns[0]!.complete).toBe(false);
    expect(result.inProgress).toBe(true);
  });

  it('보이는 답변이 없고 생성 중 빈 답변만 있어도 미완료', () => {
    const result = normalizeConversation(chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '', T0 + 1, { status: 'in_progress' })]));
    expect(result.turns.map((t) => t.complete)).toEqual([false]);
    expect(result.inProgress).toBe(true);
  });

  it('inProgress 는 마지막 턴만 본다', () => {
    const conv = chain([
      message('u1', 'user', '질문 1', T0),
      message('a1', 'assistant', '미완료', T0 + 1, { end_turn: null }),
      message('u2', 'user', '질문 2', T0 + 10),
      message('a2', 'assistant', '완료', T0 + 11),
    ]);
    const result = normalizeConversation(conv);
    expect(result.turns.map((t) => t.complete)).toEqual([false, true]);
    expect(result.inProgress).toBe(false);
  });
});

describe('시각', () => {
  it('createdAt 은 create_time(초)을 밀리초로 반올림한 ISO 다', () => {
    const conv = chain([message('u1', 'user', '질문', 1762995601.2), message('a1', 'assistant', '답', 1762995605.5006)]);
    expect(normalizeConversation(conv).turns[0]!.messages.map((m) => m.createdAt)).toEqual(['2025-11-13T01:00:01.200Z', '2025-11-13T01:00:05.501Z']);
  });

  it('start·end 는 턴 안 시각의 최소·최대다 (사용자 메시지가 답변보다 늦게 찍혀도)', () => {
    const conv = chain([message('u1', 'user', '질문', T0 + 5), message('a1', 'assistant', '답', T0 + 2)]);
    const [turn] = normalizeConversation(conv).turns;
    expect([turn!.start, turn!.end]).toEqual([iso(T0 + 2), iso(T0 + 5)]);
  });

  it('시각이 없는 메시지가 하나라도 있으면 그 턴의 start·end 는 null', () => {
    const conv = chain([message('u1', 'user', '질문', T0), message('a1', 'assistant', '답', null)]);
    const [turn] = normalizeConversation(conv).turns;
    expect([turn!.start, turn!.end]).toEqual([null, null]);
    expect(turn!.messages.map((m) => m.createdAt)).toEqual([iso(T0), null]);
    expect(turn!.complete).toBe(true);
  });

  it('날짜로 바꿀 수 없는 값은 시각 없음으로 본다', () => {
    const conv = chain([message('u1', 'user', '질문', 1e20), message('a1', 'assistant', '답', T0)]);
    expect(normalizeConversation(conv).turns[0]!.messages[0]!.createdAt).toBeNull();
  });
});

describe('turnsInWindows', () => {
  const turn = (id: string, start: string | null, end: string | null, complete = true): NormalizedTurn => ({ turnId: id, messages: [], start, end, complete });
  const window = (start: string, end: string): SyncWindow => ({ start, end });
  const W = window('2025-11-13T01:00:00.000Z', '2025-11-13T02:00:00.000Z');
  const pick = (turns: NormalizedTurn[], windows: SyncWindow[]) => turnsInWindows(turns, windows).map((t) => t.turnId);

  it('창 안의 완료 턴만 남긴다', () => {
    const inside = turn('in', '2025-11-13T01:10:00.000Z', '2025-11-13T01:10:05.000Z');
    expect(pick([inside], [W])).toEqual(['in']);
  });

  it('start 가 창 시작과 같으면 남기고, 그보다 이르면 뺀다 (start ≥ 창 시작)', () => {
    expect(pick([turn('eq', '2025-11-13T01:00:00.000Z', '2025-11-13T01:00:05.000Z')], [W])).toEqual(['eq']);
    expect(pick([turn('early', '2025-11-13T00:59:59.999Z', '2025-11-13T01:00:05.000Z')], [W])).toEqual([]);
  });

  it('end 가 창 끝과 같으면 빼고, 그보다 이르면 남긴다 (end < 창 끝)', () => {
    expect(pick([turn('eq', '2025-11-13T01:59:00.000Z', '2025-11-13T02:00:00.000Z')], [W])).toEqual([]);
    expect(pick([turn('ok', '2025-11-13T01:59:00.000Z', '2025-11-13T01:59:59.999Z')], [W])).toEqual(['ok']);
  });

  it('창 밖에서 시작해 창 안에서 끝나거나 그 반대인 턴은 뺀다', () => {
    const before = turn('before', '2025-11-13T00:30:00.000Z', '2025-11-13T01:30:00.000Z');
    const after = turn('after', '2025-11-13T01:30:00.000Z', '2025-11-13T02:30:00.000Z');
    expect(pick([before, after], [W])).toEqual([]);
  });

  it('두 조각에 걸친 턴은 뺀다 (같은 조각 안이어야 한다)', () => {
    const windows = [window('2025-11-13T01:00:00.000Z', '2025-11-13T01:10:00.000Z'), window('2025-11-13T01:20:00.000Z', '2025-11-13T02:00:00.000Z')];
    const across = turn('across', '2025-11-13T01:05:00.000Z', '2025-11-13T01:25:00.000Z');
    const second = turn('second', '2025-11-13T01:30:00.000Z', '2025-11-13T01:31:00.000Z');
    const gap = turn('gap', '2025-11-13T01:12:00.000Z', '2025-11-13T01:13:00.000Z'); // 일시정지 구간
    expect(pick([across, second, gap], windows)).toEqual(['second']);
  });

  it('미완료 턴과 시각 없는 턴은 창 안이어도 뺀다', () => {
    const incomplete = turn('incomplete', '2025-11-13T01:10:00.000Z', '2025-11-13T01:10:05.000Z', false);
    const noTime = turn('noTime', null, null);
    expect(pick([incomplete, noTime], [W])).toEqual([]);
  });

  it('창이 없으면 아무것도 남지 않고, 입력 순서는 유지한다', () => {
    const a = turn('a', '2025-11-13T01:10:00.000Z', '2025-11-13T01:10:05.000Z');
    const b = turn('b', '2025-11-13T01:20:00.000Z', '2025-11-13T01:20:05.000Z');
    expect(pick([a, b], [])).toEqual([]);
    expect(pick([a, b], [W])).toEqual(['a', 'b']);
  });

  it('시각은 문자열이 아니라 시점으로 비교한다 (시간대 표기가 달라도)', () => {
    const kst = window('2025-11-13T10:00:00.000+09:00', '2025-11-13T11:00:00.000+09:00'); // = 01:00Z ~ 02:00Z
    expect(pick([turn('t', '2025-11-13T01:10:00.000Z', '2025-11-13T01:10:05.000Z')], [kst])).toEqual(['t']);
  });
});
