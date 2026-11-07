# /ai — 분류·충돌 판정 (백엔드 A · 김하은)

팀원 AI 대화 → 후보 카드(분류), 승인된 결정 ↔ 기존 결정(충돌 판정)을 맡는 부분.
**Python 3.11+ 표준 라이브러리만** 쓴다 (pip 설치 없음). 입출력은 JSON이라 수집기·서버가 어떤 언어든 호출할 수 있다.

## 외부 AI 구성 (OpenAI)
[Decisions API](https://developers.openai.com/api/docs/guides/decisions)는 질문마다 정형 답(보기 선택·예/아니오 확률·점수)만
돌려주고 자유 텍스트·JSON 스키마는 만들지 못한다. 그래서 둘로 나눈다.

| 단계 | 맡는 AI | 하는 일 |
|---|---|---|
| 1. 추출 | chat 모델 (`AI_MODEL`, JSON 모드) | 문장 나누기, sentence·content·topic_key·reason·담당자·기한, 1차 라벨 |
| 2. 라벨 | Decisions (`AI_DECISIONS_MODEL`) | 문장마다 관련성·표시·소주제(choice)·변경(predicate). **선택 확률 = confidence** → "확인 필요" 배지가 실제 확률 기준 |
| 3. 충돌 | Decisions → chat 모델 → 규칙 | 새 결정 ↔ 비슷한 기존 결정 3개를 같음/변경/충돌/무관으로 |

Decisions 설정이 없거나 호출이 실패하면 chat 모델 라벨·판정으로, 그것도 없으면 규칙 판정으로 자동으로 내려간다.
⚠️ Decisions 실제 호출은 아직 못 해 봄 (키 없음). 응답 모양이 문서와 다르면 `syncup_ai/llm.py` 의 `DecisionsClient` 만 고친다.

```
ai/
  prompts/classify_system.md   분류 프롬프트 (docs/classification.md 기준표를 옮김)
  prompts/conflict_system.md   충돌 판정 프롬프트 (chat 모델용)
  prompts/decisions_criteria.md  Decisions 에 함께 보내는 분류 기준 요약
  syncup_ai/
    config.py      조정값: 10턴 묶음, AI 답변 발췌 길이, 충돌 후보 3개, '변경'도 경고할지
    batch.py       대화 횟수(턴) 기준 묶기
    mask.py        민감정보 가림 (외부 AI로 보내기 전에)
    classify.py    분류 → 출력 형식 정리
    schema.py      출력 형식(JSON) 정리·검사 (shared/types.ts 와 같은 모양)
    conflict.py    비슷한 결정 찾기 → AI 판정(같음/변경/충돌/무관) → Conflict 객체
    similarity.py  임베딩 또는 글자 2-gram 유사도
    decide.py      Decisions API 로 라벨·확신도 다시 매기기, 충돌 판정
    llm.py         외부 AI 연결부 (chat 모델 · Decisions · 임베딩)
  eval/            정확도·충돌 감지율 평가
  tests/           API 키 없이 도는 테스트
```

## 설정
```bash
cp .env.example .env   # AI_BASE_URL, AI_API_KEY, AI_MODEL 채우기 (.env 는 커밋 금지)
```

## 쓰는 법 (모두 `ai/` 폴더에서)
```bash
python3 -m syncup_ai classify  < request.json   # 분류
python3 -m syncup_ai conflicts < request.json   # 충돌 판정
python3 -m syncup_ai batch     < request.json   # 턴 묶기
python3 -m syncup_ai prompt    < request.json   # AI 에 보낼 프롬프트만 보기 (API 호출 없음)
python3 -m unittest -v                          # 테스트
python3 -m eval.run classify                    # 분류 예시 22개 정확도 (외부 AI 필요)
python3 -m eval.run conflict [--rule]           # 충돌 감지율 (--rule: AI 없이 규칙 기준선)
python3 -m eval.sheet_eval judge [--rule]       # 민규 님 충돌 정답표 14쌍 (정답 카드로 판정만)
python3 -m eval.sheet_eval classify             # 민규 님 샘플 대화 80발화 분류 정확도
python3 -m eval.sheet_eval e2e                  # 분류 결과로 충돌까지 (시연 흐름 그대로)
```

### 1) 분류 — 로컬 수집기(동균 님)가 호출
입력은 `shared/collector.ts` 의 `NativeClassifyRequest`, 출력은 `NativeClassifyResponse` 그대로.
확장은 `ok:false` 를 받으면 목업 분류로 대체한다.

```jsonc
{
  "type": "classify", "version": 1,
  "context": {
    "teamName": "싱크업", "projectTopic": "...", "userName": "김하은",
    "enabledSubtopics": ["주제·목표", ...], "existingTopicKeys": ["MVP 범위"],
    // ↓ 선택 (아래 '프로토콜 추가 제안')
    "knownNames": ["김동균", "김민규", "김단비"],
    "existingDecisions": [{"topic_key": "MVP 범위", "content": "브라우저 확장 = 행사 이후"}]
  },
  "messages": [ /* CollectedMessage[] — 이번에 분류할 발화 */ ],
  "contextMessages": [ /* 선택: 직전 턴. 참고만 하고 카드는 안 만듦 */ ]
}
// → {"ok": true, "cards": [ 출력 형식(JSON) ... ]}   개인 카드는 relevance·source·masked·confidence 만
```
- Codex·Claude Code 발화도 같은 `CollectedMessage` 모양으로 넣으면 된다. `site` 를 `"codex"`/`"claude-code"` 로, 또는 `source` 필드에 출처 문자열을 직접 넣으면 그대로 쓴다.
- 전화번호·이메일·계좌·주민번호는 **외부 AI로 보내기 전에** 코드로 가린다. 건강·가족 등은 AI가 가린다.
- AI 답변은 앞 1200자만 발췌해서 보낸다. AI가 말한 "~하세요"는 결정이 아니라 제안(none)으로 바꾼다.

### 2) 대화 횟수 기준 묶기
질문 1개 + 이어지는 AI 답변 = 1턴, **10턴마다** 분류 (`config.TURNS_PER_BATCH`, 조정 예정).
```jsonc
{"messages": [ /* 아직 안 보낸 발화 */ ], "flush": false}
// → {"batches": [[...20발화...]], "leftover": [...]}
```
일시중지·종료 시각·수동 보내기 때는 `"flush": true` 로 남은 것까지 보낸다. 답을 아직 못 받은 마지막 질문은 다음으로 넘긴다.

### 3) 충돌 판정 — 팀 서버 `/items/approve` 가 호출
```jsonc
{"newCards": [ /* 이번에 승인된 카드 (id 포함) */ ], "existing": [ /* 팀 보드의 기존 결정 */ ]}
// → {"ok": true,
//    "results": [{"cardId": "...", "judgements": [{"id": 기존카드id, "judgement": "같음|변경|충돌|무관", "reason": "...", "confidence": 0.8}]}],
//    "conflicts": [ shared/types.ts Conflict (cardA = 기존, cardB = 새 결정) ]}
```
- 결정(tag=decision)만 비교. 같은 topic_key 결정 + 내용이 비슷한 결정 중 **상위 3개**를 판정.
- 변경 vs 충돌 (민규 님 정답표 기준): 같은 사람이 고치거나 팀 합의로 바꾸면 **변경**, 다른 사람이 반대로 정하면 **충돌**.
- `config.CONFLICT_ON_CHANGE = True` → '변경'도 경고로 보냄 (11/7 팀 결정, 추후 다시 논의 가능). '충돌'만 경고하려면 False.

## 프로토콜 추가 제안 (모두 선택 필드 — 없어도 동작. 11/8 제출은 현재 확장 형식 그대로, 추가는 그 이후)
| 필드 | 왜 | 누가 채움 |
|---|---|---|
| `context.knownNames` | "유나가 하자" → 담당자 최유나 | 확장 설정(팀원 목록) |
| `context.existingDecisions` | 기존 결정과 다른 값이면 `is_change` 판단 | 확장 또는 수집기가 팀 보드에서 |
| `contextMessages` | "그걸로 하자" 같은 지시어 해석 | 수집기 (`batch.context_tail`) |

## 평가
- 데이터: `eval/gold.py`(분류 기준표 예시 22개 + 충돌 8쌍), `data/`(민규 님 샘플 대화 80발화·정답 125단위·충돌 14쌍).
- 프롬프트 속 예시는 두 평가 데이터와 겹치지 않는 새 문장으로 만들었다 (정답 유출 방지).
- 충돌 감지율 목표 80% 이상 (2차 회의).
- AI 없는 규칙 기준선 (11/7):

| 데이터 | 감지율 | 오경보율 | 판정 정확도 | 틀린 것 |
|---|---|---|---|---|
| 민규 님 충돌 14쌍 | 1.00 | 0.43 | 0.79 | '같음' 3쌍을 '변경'으로 (표현만 다른 같은 결정 → AI 몫) |
| 기준표 8쌍 | 0.80 | 0.33 | 0.75 | topic_key 가 다른 같은 대상, 범위만 좁힌 결정 |

- 분류 채점 (`sheet_eval classify`): 공유 후보(결정·할 일·조사) 재현율·정밀도, 표시별 재현율, 소주제·담당자·기한·변경 정확도,
  개인 내용 유출 수, AI 답변에서 잘못 만든 카드 수, 전화번호 유출 수. '해당 없음(요청·제안)'은 카드를 안 만들어도 정답.
