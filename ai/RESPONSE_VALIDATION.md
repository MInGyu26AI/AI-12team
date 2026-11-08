# Decisions 응답 검증

`DecisionsClient`가 응답을 반환하기 전에 질문별 name, type, 값과 확률을 검사한다. 질문 name은 이 클라이언트의 사전형 반환 계약상 필수이며 전체 호출에서 중복될 수 없다. 각 400질문 배치도 자기 질문의 답만 받는다. 응답 순서에 의존하지 않는다.

- answers는 배열이어야 하며, 모든 질문의 답이 정확히 한 번 있어야 한다.
- refusal, 예상 밖 name, 중복, 누락, type 불일치는 전체 실패다. 앞선 배치의 일부 답도 반환하지 않는다.
- choice는 질문에 있는 문자열/불리언 값이어야 한다. 불리언과 숫자를 혼동하지 않는다.
- confidence가 있으면 0~1 유한수여야 한다. 숫자 문자열, 불리언, null, NaN, 무한대는 거부한다.
- predicate probability도 같은 숫자 규칙을 따른다.
- probabilities가 있으면 모든 선택지/수준을 정확히 한 번 포함해야 한다. 각 probability의 범위와 전체 합 1을 검사한다. choice는 최대 확률의 선택지(동률 허용), score는 수준 인덱스 가중평균과 일치해야 한다. 합/정합성의 절대 오차 허용치는 1e-6이다.
- score는 0부터 마지막 수준 인덱스 사이의 유한수이고, 분포의 정수 인덱스 및 label도 질문과 일치해야 한다.
- 모델명, 사용량 등 판정에 사용하지 않는 부가 필드는 필수화하지 않는다.

## 호환성과 실패 전달

[공식 응답 정의](https://developers.openai.com/api/reference/resources/decisions/methods/create)는 choice/score에 confidence와 probabilities를 모두 표시한다. 현재 프로젝트의 confidence-only 응답 및 confidence 부재 시 분포를 쓰는 경로를 보존한다. 둘 중 하나만 없어도 허용하지만 **둘 다 없으면 실패**한다. 분포가 있다면 부분 분포는 허용하지 않는다. 공식 API가 해당 필드를 optional로 선언했다는 뜻은 아니다.

[공식 가이드](https://developers.openai.com/api/docs/guides/decisions)의 confidence는 분포와 별도의 값이다. 둘이 같아야 한다는 검사는 하지 않는다. 기존 confidence 우선순위와 0.6 경계도 바꾸지 않는다.

잘못된 JSON/UTF-8, 응답 검증 실패 및 refusal은 `DecisionsResponseError`다. `RetryableLLMError`가 아니므로 충돌 검사의 결과는 기존 `ok=false`, `checkStatus=failed`, `failureReason=check-failed`, `retryable=false`다. 분류에서도 해당 오류만 전파하여 chat 라벨로 성공 처리하지 않는다. 기존 다른 오류의 분류 대체 정책과 통신 실패 최대 3회 정책은 변경하지 않는다.

수정은 llm.py, classify.py 및 테스트/문서에 한정한다. 진단 스키마, 저장소, integration.py, 웹/확장은 바꾸지 않는다. 실제 키나 외부 API는 사용하지 않는다.
