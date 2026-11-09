# /ai — 분류·충돌 판정 (백엔드 A · 김하은)

팀원 AI 대화 → 후보 카드(분류), 승인된 결정 ↔ 기존 결정(충돌 판정)을 맡는 부분.
**Python 3.11+ 표준 라이브러리만** 쓴다 (pip 설치 없음). 입출력은 JSON이라 수집기·서버가 어떤 언어든 호출할 수 있다.

## 외부 AI 구성 (OpenAI)
[Decisions API](https://developers.openai.com/api/docs/guides/decisions)는 질문마다 정형 답(보기 선택·예/아니오 확률·점수)만
돌려주고 자유 텍스트·JSON 스키마는 만들지 못한다. 그래서 둘로 나눈다.

| 단계 | 맡는 AI | 하는 일 |
|---|---|---|
| 1. 추출 | chat 모델 (`AI_MODEL`, JSON 모드) | 문장 나누기, sentence·content·topic_key·reason·담당자·기한, 1차 라벨 |
| 2. 라벨 | Decisions (`AI_DECISIONS_MODEL`) | 문장마다 관련성·표시·소주제(choice)·변경(predicate). API의 confidence를 우선 사용해 "확인 필요" 표시 |
| 3. 충돌 | Decisions → chat 모델 | 유효 승인 결정을 한 쌍씩 전부 비교하여 최종 값 기준으로 같음/변경/충돌/무관 판정. 규칙 대체를 허용한 오프라인 호출만 규칙 사용 |

Decisions 설정이 없거나 호출이 실패하면 chat 모델 라벨·판정으로 내려간다. 단, Decisions가 답을 거절하거나 응답 형식이 잘못되면(`DecisionsResponseError`) chat 라벨로 대신하지 않고 실패로 처리한다([응답 검증](RESPONSE_VALIDATION.md)). 팀 서버는 두 AI 경로가 모두 실패하면 검사 실패로 보존한다. CLI·오프라인에서 규칙 대체를 허용한 호출은 `checkStatus: degraded`이며 AI 검사 완료가 아니다.
2026-11-08 최종 값 기준과 한 쌍씩 비교를 적용해 합성 사례 96회를 실제 Decisions API로 검사했다. 73회 전체 완료·완료 결과 오판 0회, 23회 낮은 확신도로 미완료였다. 이후 동일 입력 재검증을 제거하고 저장 응답 96회를 재생해 같은 결과와 23회 호출 감소를 확인했다. [최종 값 검증](../../SyncUp_Decisions_최종값_수정과검증_20261108.md) · [재시도 정책 검증](../../SyncUp_통신실패만_재시도_수정검증_20261108.md). 부분 겹침과 실제 사용자 대화의 정확도는 보장하지 않는다.

```
ai/
  prompts/classify_system.md   분류 프롬프트 (docs/classification.md 기준표를 옮김)
  prompts/conflict_system.md   충돌 판정 프롬프트 (chat 모델용)
  prompts/decisions_criteria.md  Decisions 에 함께 보내는 분류 기준 요약
  syncup_ai/
    config.py      조정값: 10턴 묶음, AI 답변 발췌 길이, 충돌 호출당 1쌍·전체 비교 한도, '변경'도 경고할지
    batch.py       대화 횟수(턴) 기준 묶기
    mask.py        민감정보 가림 (외부 AI로 보내기 전에)
    classify.py    분류 → 출력 형식 정리
    schema.py      출력 형식(JSON) 정리·검사 (shared/types.ts 와 같은 모양)
    conflict.py    비슷한 결정 찾기 → AI 판정(같음/변경/충돌/무관) → Conflict 객체
    similarity.py  글자 2-gram 유사도 (충돌 후보를 비교할 순서)
    decide.py      Decisions API 로 라벨·확신도 다시 매기기, 충돌 판정
    llm.py         외부 AI 연결부 (chat 모델 · Decisions)
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
- 팀 서버가 같은 팀의 이전 승인 결정을 전달한다. 그중 현재 유효한 결정(tag=decision)만 비교한다. 이 AI 함수 자체는 팀 접근 권한을 부여하거나 확인하지 않는다.
- 같은 topic_key와 로컬 문자열 유사도는 **순서만** 정한다. 다른 키·낮은 유사도·4번째 이후 후보도 제외하지 않고 **한 쌍씩 전부** Decisions에 전달한다. `CONFLICT_TOP_K=1`은 호출당 비교 수이며 후보를 하나로 자르는 제한이 아니다. 순서 정렬에는 외부 임베딩을 호출하지 않는다.
- 실제 대상·결정 항목·적용 범위와 시점을 확인한 뒤 **현재 비교하는 두 결정의 최종 값**을 판단한다. 신규가 A에서 B로 바뀌었다고 말해도 기존 값이 이미 B이면 같음이다. 다른 과거 결정의 변경 이력으로 현재 쌍을 변경이라고 판단하지 않는다.
- 기존 범위를 부정하지 않는 구체화는 같음이다. 기존 포함 대상을 제외·대체하는 축소는 수정으로 보고 결정자·팀 합의에 따라 변경/충돌을 판단한다. 독립 범위가 부분적으로 겹치면 교집합의 모순을 검사한다. 모순이 있으면 변경/충돌, 없으면 무관(양립 가능)이다. 같음 판정 자체는 카드 자동 병합·삭제 지시가 아니다.
- 한 입력에 여러 기존 결정을 넣었을 때의 값 혼동이 실제 호출에서 관찰돼 기본 비교 단위를 1로 바꿨다. 호출 수와 지연이 늘며, 높은 확신도의 오판 가능성까지 없애는 것은 아니다. 실제 결과는 `../../SyncUp_Decisions_최종값_수정과검증_20261108.md` 참고.
- **팀 API의 재개 가능한 검사:** 승인 당시보다 앞선 활성·검토 중 결정을 모두 정렬하고 후보 ID 목록을 DB에 저장한다. 한 쌍마다 결과와 진행 위치를 함께 커밋하며, 30개는 worker가 한 번에 처리할 작업 수다. 30개를 초과해도 다음 실행을 자동 예약해 끝까지 이어간다. 새 승인은 자신의 이전 결정들과 비교하므로 기존 쌍을 반복하지 않는다.
- **동기 CLI 한도:** CLI에 한꺼번에 전달하는 후보는 기존 30개, 입력 30,000자, 호출 전후 90초 제한을 유지한다. 팀 worker는 한 쌍씩 이 함수를 호출하므로 총 후보 수 때문에 막히지 않는다. 한 쌍 자체의 입력·응답·시간 오류는 확인 필요로 남긴다. 진행 중 HTTP 요청을 즉시 취소하지는 않는다.
- 보드의 `conflictCheckProgress`는 `{total, completed, skipped}`를 반환한다. `skipped`는 검사 도중 비활성화된 결정이며 검사한 건수와 구분한다. 일부 완료 상태는 `pending/running/failed`로 남고 발견한 충돌은 즉시 표시한다. 모든 대상이 처리되어야 `complete`이며, 잘못된 응답이 빠진 비교를 완료로 처리하지 않는다.
- Decisions 실패 시 해당 묶음만 chat으로 재시도한다. 모든 묶음이 판정돼야 `complete`다. 일부가 규칙이면 `degraded`다.
- AI의 모든 관계(`같음`·`무관`·`변경`·`충돌`)는 `LOW_CONFIDENCE=0.6`을 유지한다. Decisions의 낮은 확신도에만 한 번의 독립 검토를 허용한다: 기존 추론 모델이 원문을 별도로 판정하고, Decisions는 기존 카드의 결정자 정보를 명시한 입력으로 한 쌍을 다시 판단한다. 검토 모델의 결론은 Decisions에 전달하지 않는다. 두 결과 모두 0.6 이상이고 관계가 일치해야 완료하며, 최종 확신도는 둘 중 작은 값이다. `reviewedBy=chat`과 검토 확신도를 결과에 남기고 진단에는 두 방법을 기록한다.
- 검토자가 없거나, 불일치·낮은 확신도·잘못된 응답·시간 초과이면 계속 `failed`/확인 필요로 남긴다. 동일한 입력을 확신도가 오를 때까지 반복하거나 규칙 결과로 대체하지 않는다. 정상적으로 확신도가 충분한 Decisions 결과에는 추가 호출이 없다. 보완 검토는 한 쌍에 추론 모델 1회와 Decisions 1회를 최대 추가하며, 0.6이나 모델 간 합의가 실제 정확도를 보장하지는 않는다.
- `RetryableLLMError`인 일시적인 통신 실패(연결 실패·시간 초과·응답 단절, HTTP 408/429/500/502/503/504)에만 기존 Decisions→chat 대체를 허용한다. 두 경로 모두 통신 실패하면 서버가 30초 뒤부터 작업을 다시 시도할 수 있으며 **최초 시도 포함 최대 3회**다. 인증·요청 오류, 인증서 오류, 누락·잘못된 응답, 후보·크기·전체 시간 한도 초과는 자동 재시도하지 않는다. 클라이언트는 같은 요청을 자체 반복하지 않는다.
- 서버는 기존 상태를 재사용한다. 통신 재시도 대기는 `pending`, 확신도 부족·영구 오류·한도 도달은 `failed`다. 재시도는 완료한 비교를 보존하고 실패한 쌍부터 시작한다. 프로세스 중단 시 저장된 진행 상태가 있는 작업은 3분 임대 만료 후 자동 재개한다. 서버 재시작 후에는 인증된 팀 요청이 worker를 깨운다. 인증 토큰을 DB에 저장하거나 관리자 권한으로 RLS를 우회하지 않는다. 진행 상태가 없는 이전 버전의 중단·실패는 기존 수동 재시도를 유지한다.
- `team_admin.py migrate-integration`으로 `conflict_checks.progress` 열을 추가해야 한다(재실행 가능, 승인 기록 보존). 진행 상태에는 승인 카드 ID·커서·제외 수·판정 정책 해시만 저장한다. 진행 중 정책/모델 설정이 달라지면 비교 목록을 다시 만들고 처음부터 검사한다. 이미 표시한 충돌은 검토 이력으로 유지하며 자동 삭제하지 않는다. 완료된 과거 작업 전체를 재평가하는 기능은 아니다.
- 검색용 `topic_key`는 정렬에만 쓰며 AI 판정 근거에서 제외한다. 실제 내용·원문·이유·결정자·출처는 보존한다. 현재 구현은 전체 대화에서 프로젝트·행사 귀속을 추출하지 않는다.
- 초기 `변경`·`충돌` 경고와 명시적 오프라인 규칙의 `degraded` 처리는 유지한다. 확신도 0을 보존하고 판정 기준 적용 전에 반올림하지 않는다.
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
