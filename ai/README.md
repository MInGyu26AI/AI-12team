# /ai — 분류·충돌 판정 (백엔드 A · 김하은)

팀원 AI 대화 → 후보 카드(분류), 승인된 결정 ↔ 기존 결정(충돌 판정)을 맡는 부분.
**Python 3.11+ 표준 라이브러리만** 쓴다 (pip 설치 없음). 로컬 수집기와 팀 서버는 이 패키지를 같은 프로세스에서 import 해 쓰고,
명령줄(`python -m syncup_ai`)은 같은 함수를 JSON stdin/stdout 으로 부른다.

## 외부 AI 구성 (OpenAI)
[Decisions API](https://developers.openai.com/api/docs/guides/decisions)는 질문마다 정형 답(보기 선택·예/아니오 확률·점수)만
돌려주고 자유 텍스트·JSON 스키마는 만들지 못한다. 그래서 둘로 나눈다.

| 단계 | 맡는 AI | 하는 일 |
|---|---|---|
| 1. 추출 | chat 모델: 기본은 OpenAI Responses `gpt-6.1-terra`, 다른 공급자는 `AI_MODEL`(OpenAI 호환, JSON 모드) | 문장 나누기, sentence·content·topic_key·reason·담당자·기한, 1차 라벨 |
| 2. 라벨 | Decisions: 기본 `gpt-6-luna`(`AI_DECISIONS_MODEL`로 바꿈) | 문장마다 관련성·표시·소주제(choice)·변경(predicate). API의 confidence를 우선 사용해 "확인 필요" 표시 |
| 3. 충돌 | Decisions → (Decisions 가 없거나 통신 실패면) chat 모델 | 유효 승인 결정을 한 쌍씩 전부 비교하여 최종 값 기준으로 같음/변경/충돌/무관 판정. 규칙 대체를 허용한 오프라인 호출만 규칙 사용 |

분류는 Decisions 설정이 없거나 호출이 실패하면 chat 모델 라벨을 그대로 쓴다. 단, Decisions가 답을 거절하거나 응답 형식이 잘못되면(`DecisionsResponseError`) chat 라벨로 대신하지 않고 실패로 처리한다([응답 검증](RESPONSE_VALIDATION.md)). 충돌 검사는 Decisions 설정이 없으면 chat 모델로 판정하고, 설정이 있으면 통신 실패(`RetryableLLMError`)일 때만 chat 모델로 대신 판정한다. 팀 서버는 두 AI 경로가 모두 실패하면 검사 실패로 보존한다. CLI·오프라인에서 규칙 대체를 허용한 호출은 `checkStatus: degraded`이며 AI 검사 완료가 아니다.
합성 사례로 잰 결과와 한계는 [검증 요약](../docs/verification.md)과 [독립 검토 기록](../docs/appendix/decision-independent-review-20261108.md)을 본다. 부분 겹침과 실제 사용자 대화의 정확도는 보장하지 않는다.

```
ai/
  prompts/classify_system.md   분류 프롬프트 (docs/classification.md 기준표를 옮김)
  prompts/conflict_system.md   충돌 판정 프롬프트 (chat 모델용)
  prompts/decisions_criteria.md  Decisions 에 함께 보내는 분류 기준 요약
  RESPONSE_VALIDATION.md       Decisions 응답 검증 규칙
  syncup_ai/
    __main__.py    명령줄 (python -m syncup_ai)
    config.py      조정값: 10턴 묶음, AI 답변 발췌 길이, 충돌 호출당 1쌍·전체 비교 한도, '변경'도 경고할지
    batch.py       대화 횟수(턴) 기준 묶기
    mask.py        민감정보 가림 (외부 AI로 보내기 전에)
    classify.py    분류 → 출력 형식 정리
    evidence.py    가린 근거 문장이 입력 발화의 어느 구간인지 확인
    schema.py      출력 형식(JSON) 정리·검사 (shared/types.ts 와 같은 모양)
    conflict.py    비슷한 결정 찾기 → AI 판정(같음/변경/충돌/무관) → Conflict 객체
    similarity.py  글자 2-gram 유사도 (충돌 후보를 비교할 순서)
    decide.py      Decisions API 로 라벨·확신도 다시 매기기, 충돌 판정
    llm.py         외부 AI 연결부 (chat 모델 · Decisions)
  eval/            정확도·충돌 감지율 평가 (scoring.py: 실패를 미완료로 세는 호출·감지율·결과 저장)
  tests/           API 키 없이 도는 테스트 (fakes.py: 가짜 AI 클라이언트, loopback.py: 시험용 HTTP 서버)
```

## 설정
```bash
cp .env.example .env   # .env 는 커밋 금지
```
- 기본 경로: `OPENAI_API_KEY`만 둔다(셸 환경변수 또는 `ai/.env`). chat 모델은 Responses `gpt-6.1-terra`, Decisions는 `gpt-6-luna`(`AI_DECISIONS_MODEL`로 바꿈)를 쓴다. 이때 `AI_BASE_URL`·`AI_API_KEY`·`AI_MODEL`은 비워 둔다. 하나라도 채우면 기본 경로가 꺼진다. `AI_JSON_MODE`는 이 경로에서 쓰지 않는다.
- 다른 OpenAI 호환 공급자: `AI_BASE_URL`·`AI_API_KEY`·`AI_MODEL` 세 값을 함께 채운다. Decisions는 `AI_DECISIONS_MODEL`이 있을 때만 같은 주소·키로 부른다.

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

### 1) 분류 — 로컬 수집기의 통합 분류가 같은 프로세스에서 `classify.handle_request` 호출
입력은 `shared/collector.ts` 의 `NativeClassifyRequest` 모양에 선택 필드 `contextMessages`를 더한 것, 출력은 `NativeClassifyResponse`.
`ok:false`면 수집기가 원문을 보존한 채 그 작업을 실패로 남기고, 검토 화면에서 다시 시도할 수 있다. 목업 분류로 바꾸지 않는다.

```jsonc
{
  "type": "classify", "version": 1,
  "context": {
    "teamName": "싱크업", "projectTopic": "...", "userName": "김하은",
    "enabledSubtopics": ["주제·목표", ...], "existingTopicKeys": ["MVP 범위"],
    // ↓ 선택 (아래 '선택 필드')
    "knownNames": ["김동균", "김민규", "김단비"],
    "existingDecisions": [{"topic_key": "MVP 범위", "content": "브라우저 확장 = 행사 이후"}]
  },
  "messages": [ /* CollectedMessage[] — 이번에 분류할 발화 */ ],
  "contextMessages": [ /* 선택: 직전 턴. 참고만 하고 카드는 안 만듦 */ ]
}
// → {"ok": true, "cards": [ 출력 형식(JSON) ... ]}   개인 카드는 relevance·source·masked·confidence 만
```
- Codex·Claude Code 발화도 같은 `CollectedMessage` 모양으로 넣으면 된다. `site` 를 `"codex"`/`"claude-code"` 로, 또는 `source` 필드에 출처 문자열을 직접 넣으면 그대로 쓴다.
- 전화번호·이메일·계좌·주민번호와 API 키·토큰·비밀번호는 **외부 AI로 보내기 전에** 코드로 가린다(`mask.py`). 건강·가족 등은 AI가 가린다.
- AI 답변은 앞 1200자만 발췌해서 보낸다. AI가 말한 "~하세요"는 결정이 아니라 제안(none)으로 바꾼다.

### 2) 대화 횟수 기준 묶기
질문 1개 + 이어지는 AI 답변 = 1턴, **10턴마다** 분류 (`config.TURNS_PER_BATCH`).
`turnId`가 있는 발화(코딩 도구 로그)는 같은 `turnId`끼리 한 턴이고, `complete: true`인 사용자 발화는 답을 기다리지 않는다.
```jsonc
{"messages": [ /* 아직 안 보낸 발화 */ ], "flush": false}
// → {"batches": [[...20발화...]], "leftover": [...]}
```
수동 보내기 때는 `"flush": true` 로 남은 것까지 보낸다. 일시중지·종료 때 남은 대화는 보내지 않고 로컬에 둔다. flush 가 아니면 답을 아직 못 받은 마지막 질문은 다음으로 넘긴다.

### 3) 충돌 판정 — 팀 서버의 충돌 검사 worker(`process_checks`)가 한 쌍씩 호출
승인 API(`/items/approve`)는 카드를 저장만 하고, 검사 결과는 보드의 `conflictCheckProgress`와 충돌 목록으로 본다.
`conflict.handle_request` 입력과 반환 모양:
```jsonc
{"newCards": [ /* 이번에 승인된 카드 (id 포함) */ ], "existing": [ /* 팀 보드의 기존 결정 */ ]}
// → {"ok": true, "checkStatus": "complete|degraded",
//    "results": [{"cardId": "...", "judgements": [{"id": 기존카드id, "judgement": "같음|변경|충돌|무관", "reason": "...", "confidence": 0.8}]}],
//    "conflicts": [ shared/types.ts Conflict (cardA = 기존, cardB = 새 결정) ]}
// 실패: {"ok": false, "checkStatus": "failed", "failureReason": "low-confidence|communication|check-failed", "retryable": bool}
```
- 호출하는 쪽이 같은 팀의 이전 승인 결정을 전달한다. 그중 현재 유효한 결정(tag=decision)만 비교한다. 이 AI 함수 자체는 팀 접근 권한을 부여하거나 확인하지 않는다.
- 같은 topic_key와 로컬 문자열 유사도는 **순서만** 정한다. 다른 키나 낮은 유사도의 후보도 제외하지 않고 **한 쌍씩 전부** Decisions에 전달한다. 순서 정렬에는 외부 임베딩을 호출하지 않는다.
- 기본 비교 단위는 한 쌍(`CONFLICT_TOP_K=1`)이다. 여러 결정을 한 입력에 넣으면 값이 섞여서다. 호출 수와 지연이 늘며, 높은 확신도의 오판까지 없애지는 않는다.
- 실제 대상·결정 항목·적용 범위와 시점을 확인한 뒤 **현재 비교하는 두 결정의 최종 값**을 판단한다. 신규가 A에서 B로 바뀌었다고 말해도 기존 값이 이미 B이면 같음이다. 다른 과거 결정의 변경 이력으로 현재 쌍을 변경이라고 판단하지 않는다.
- 기존 범위를 부정하지 않는 구체화는 같음이다. 기존 포함 대상을 제외·대체하는 축소는 수정으로 보고 결정자·팀 합의에 따라 변경/충돌을 판단한다. 독립 범위가 부분적으로 겹치면 교집합의 모순을 검사한다. 모순이 있으면 변경/충돌, 없으면 무관(양립 가능)이다. 같음 판정 자체는 카드 자동 병합·삭제 지시가 아니다.
- **동기 호출 한도:** 한 번에 넘기는 후보는 기존 30개, 입력 30,000자, 호출 전후 90초까지다. 진행 중 HTTP 요청을 즉시 취소하지는 않는다. 팀 worker는 한 쌍씩 부르므로 총 후보 수에 막히지 않는다. 재개·재시도·진행 상태 정책은 [충돌 검사 재개 기록](../docs/appendix/resumable-conflict-verification-20261108.md)을 본다.
- Decisions 설정이 있으면 통신 실패(`RetryableLLMError`: 연결 실패·시간 초과·응답 단절, HTTP 408/429/500/502/503/504)일 때만 해당 묶음을 chat으로 다시 판정한다. 인증·요청 오류, 인증서 오류, 누락·잘못된 응답, 한도 초과는 대체하지 않는다. 모든 묶음이 AI로 판정돼야 `complete`이고, 일부가 규칙이면 `degraded`다. 클라이언트는 같은 요청을 자체 반복하지 않는다.
- AI의 모든 관계(`같음`·`무관`·`변경`·`충돌`)는 `LOW_CONFIDENCE=0.6`을 유지한다. Decisions의 낮은 확신도에만 한 번의 독립 검토를 허용한다: 기존 추론 모델이 원문을 별도로 판정하고, Decisions는 기존 카드의 결정자 정보를 명시한 입력으로 한 쌍을 다시 판단한다. 검토 모델의 결론은 Decisions에 전달하지 않는다. 두 결과 모두 0.6 이상이고 관계가 일치해야 완료하며, 최종 확신도는 둘 중 작은 값이다. `reviewedBy=chat`과 검토 확신도를 결과에 남긴다.
- 검토자가 없거나, 불일치·낮은 확신도·잘못된 응답·시간 초과이면 계속 확인 필요(`low-confidence`)로 남긴다. 동일한 입력을 확신도가 오를 때까지 반복하거나 규칙 결과로 대체하지 않는다. 정상적으로 확신도가 충분한 Decisions 결과에는 추가 호출이 없다. 보완 검토는 한 쌍에 추론 모델 1회와 Decisions 1회를 최대 추가하며, 0.6이나 모델 간 합의가 실제 정확도를 보장하지는 않는다.
- 검색용 `topic_key`는 정렬에만 쓰며 AI 판정 근거에서 제외한다. 실제 내용·원문·이유·결정자·출처는 보존한다. 현재 구현은 전체 대화에서 프로젝트·행사 귀속을 추출하지 않는다.
- `변경`·`충돌`을 경고하고, 규칙 대체를 허용한 오프라인 호출의 결과는 `degraded`로 표시한다. 확신도 0은 그대로 두고 기준과 비교하기 전에 반올림하지 않는다.
- 변경 vs 충돌 (민규 님 정답표 기준): 같은 사람이 고치거나 팀 합의로 바꾸면 **변경**, 다른 사람이 반대로 정하면 **충돌**.
- `config.CONFLICT_ON_CHANGE = True` → '변경'도 경고로 보냄 (11/7 팀 결정, 추후 다시 논의 가능). '충돌'만 경고하려면 False.

## 선택 필드 (없어도 동작)
| 필드 | 왜 | 현재 사용 |
|---|---|---|
| `context.knownNames` | "유나가 하자" → 담당자 최유나 | 로컬 수집기는 아직 채우지 않음 (평가 스크립트만 씀) |
| `context.existingDecisions` | 기존 결정과 다른 값이면 `is_change` 판단 | 로컬 수집기는 아직 채우지 않음 (평가 스크립트만 씀) |
| `contextMessages` | "그걸로 하자" 같은 지시어 해석 | 사용 중: 로컬 수집기가 직전 묶음의 마지막 턴(`batch.context_tail`)을 넣음 |

## 평가
- 데이터: `eval/gold.py`(분류 기준표 예시 22개 + 충돌 8쌍), `data/`(민규 님 샘플 대화 80발화·정답 125단위·충돌 14쌍).
- 프롬프트 속 예시는 두 평가 데이터와 겹치지 않는 새 문장으로 만들었다 (정답 유출 방지).
- 실제 AI가 낮은 확신도 등으로 끝내지 못한 묶음·쌍은 `incomplete`로 세고 비율 계산에서 뺀다. e2e는 팀 worker처럼 한 쌍씩 판정한다.
- 충돌 감지율 목표 80% 이상 (2차 회의).
- AI 없는 규칙 기준선 (11/7):

| 데이터 | 감지율 | 오경보율 | 판정 정확도 | 틀린 것 |
|---|---|---|---|---|
| 민규 님 충돌 14쌍 | 1.00 | 0.43 | 0.79 | '같음' 3쌍을 '변경'으로 (표현만 다른 같은 결정 → AI 몫) |
| 기준표 8쌍 | 0.80 | 0.33 | 0.75 | topic_key 가 다른 같은 대상, 범위만 좁힌 결정 |

- 분류 채점 (`sheet_eval classify`): 공유 후보(결정·할 일·조사) 재현율·정밀도, 표시별 재현율, 소주제·담당자·기한·변경 정확도,
  개인 내용 유출 수, AI 답변에서 잘못 만든 카드 수, 전화번호 유출 수. '해당 없음(요청·제안)'은 카드를 안 만들어도 정답.
