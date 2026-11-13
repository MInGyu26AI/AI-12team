# CUBIG SynTitan 활용 범위

SynTitan 은 개발·검증 단계에서만 쓴다. 서비스 흐름(수집 → 분류 → 승인 → 충돌 검사)에는 들어가지 않는다.
일반 사용자는 SynTitan 계정이 없고, SynTitan 은 실시간 처리 API 가 아니기 때문이다 (2차 최종 회의 11장).

## 쓴 것

| 기능 | 무엇을 | 결과 |
|---|---|---|
| Ready for Agent | 분류 기준표(docs/classification.md)와 충돌 판정 규칙([conflict_rules.md](conflict_rules.md))을 올려 충돌 판정 테스트 케이스를 만듦 (일반 데이터) | 케이스 133개, 입력 164개 ([package/](package/)) |
| Ready for Raw Data | 민규 님 정답표(문장·라벨·대화 ID)를 CSV로 올려 빈칸·중복 행 진단 (무료) | 진단 결과 받으면 여기 기록 |

## 쓰지 않은 것

- 대화문 합성: SynTitan 은 표 데이터와 업무 문서만 다룬다. 팀 대화 30개는 Claude 로 만들었다 ([../synth](../synth)). 보고서에 'SynTitan 합성 대화'라고 쓰지 않는다.
- 문장 속 개인정보 가림 비교: 마찬가지 이유로 우리 자체 세트로 잰다 ([../mask_set.py](../mask_set.py)).

## Ready for Agent 케이스로 재는 법

SynTitan 안내(package/README.md)대로 전후 비교 동안 모델·설정은 그대로 두고 우리 자료(프롬프트·규칙)만 바꾼다.

1. 패키지에 정답이 없어 규칙 기준으로 정답을 정했다: [labels.csv](labels.csv) (review=검수 는 사람이 다시 봄)
2. 정답 종류별로 개발용 68개 / 최종 측정용 65개로 나눴다. 최종 측정용은 마지막에 한 번만 잰다
3. `python3 -m eval.agent_cases run --split dev --tag v1` → 프롬프트 보완 → `--split final --tag v2`
4. 화면 알림(없음·변경·충돌·확인 필요) 기준 정답률, 놓친 충돌, 불필요한 알림, 확인 필요 비율을 보고한다

## 발표 문장 (숫자는 측정 뒤 채움)

"분류 기준과 충돌 예외 규칙으로 SynTitan Ready for Agent 에서 만든 케이스 164건으로 충돌 판정을 검증, 알림 정답률 ○% → ○%, 놓친 충돌 ○건 → ○건, 불필요한 알림 ○건 → ○건"
