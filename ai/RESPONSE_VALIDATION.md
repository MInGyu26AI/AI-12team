# Decisions 응답 검증

`DecisionsClient`가 응답을 반환하기 전에 질문별 name, type, 값과 확률을 검사한다. 질문 name은 이 클라이언트의 사전형 반환 계약상 필수이며 전체 호출에서 중복될 수 없다. 각 400질문 배치도 자기 질문의 답만 받는다. 응답 순서에 의존하지 않는다.

- answers는 배열이어야 하며, 모든 질문의 답이 정확히 한 번 있어야 한다.
- refusal, 예상 밖 name, 중복, 누락, type 불일치는 전체 실패다. 앞선 배치의 일부 답도 반환하지 않는다.
- choice는 질문에 있는 문자열/불리언 값이어야 한다. 불리언과 숫자를 혼동하지 않는다.
- confidence가 있으면 0~1 유한수여야 한다. 숫자 문자열, 불리언, null, NaN, 무한대는 거부한다.
- predicate probability도 같은 숫자 규칙을 따른다.
- probabilities가 있으면 모든 선택지를 정확히 한 번 포함해야 한다. 각 probability의 범위와 전체 합 1을 검사한다. choice는 최대 확률의 선택지(동률 허용)와 일치해야 한다. 합/정합성의 절대 오차 허용치는 1e-6이다.
- 이 프로젝트는 choice·predicate 질문만 보낸다. score 질문은 요청 전에 거부한다.
- 모델명, 사용량 등 판정에 사용하지 않는 부가 필드는 필수화하지 않는다.

## 호환성과 실패 전달

[공식 응답 정의](https://developers.openai.com/api/reference/resources/decisions/methods/create)는 choice에 confidence와 probabilities를 모두 표시한다. 이 클라이언트는 둘 중 하나만 있어도 받는다(confidence가 있으면 그 값, 없으면 분포의 최댓값을 확신도로 쓴다). **둘 다 없으면 실패**하고, 분포가 있으면 부분 분포는 받지 않는다. 공식 API가 해당 필드를 optional로 선언했다는 뜻은 아니다.

[공식 가이드](https://developers.openai.com/api/docs/guides/decisions)의 confidence는 분포와 별도의 값이다. 둘이 같아야 한다는 검사는 하지 않는다. 확신도는 confidence를 먼저 쓰고, 0.6 미만이면 확인 필요다.

잘못된 JSON/UTF-8, 응답 검증 실패, refusal, 답 누락은 `DecisionsResponseError`다. `RetryableLLMError`가 아니므로 충돌 검사 결과는 `ok=false`, `checkStatus=failed`, `failureReason=check-failed`, `retryable=false`다. 분류도 이 오류는 그대로 올려 chat 라벨로 성공 처리하지 않는다. 그 밖의 Decisions 실패(인증·통신 등)에서 분류는 chat 라벨을 쓰고, 통신 실패의 서버 자동 재시도는 최초 시도 포함 최대 3회다.
