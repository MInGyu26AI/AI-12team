# 상세 근거와 작업 기록

[서버 구현 안내](../README.md) · [검증 요약](../verification.md)

개발 과정의 문서와 평가 파일을 보존한 부록입니다. 날짜가 있는 기록은 그 시점의 구현·모델·배포 상태를 설명하며 현재 상태를 대신하지 않습니다. 문서 안의 `work/...` 경로는 개발 Mac의 별도 근거 위치로, 이 저장소에 포함된 링크가 아닙니다. 별도 표시가 없는 실행 명령과 코드 파일명은 저장소 루트를 기준으로 읽습니다.

## 현재 설정과 운영 참고

- [QAT 모델·엄격한 JSON·정책 v3](privacy-model-v3.md)
- [개인정보 필터 설계와 과거 모델 비교](local-privacy-gate.md)
- [DB 운영·마이그레이션·보존 정책](db-operations.md)
- [최소 진단 기록](minimal-diagnostics.md)

## 구현·검증 이력

- [낮은 확신도 판정의 독립 검토](decision-independent-review-20261108.md)
- [진행 저장·중단 복구](resumable-conflict-verification-20261108.md)
- [통합 검증 당시 기록](integration-verification-20261108.md)
- [로컬 수집·복구 구현 계약](local-functional-contract.md)

## 원본 평가 자료

- [이전 로컬 모델 평가 JSON과 마스킹 검사 스크립트](local-privacy-eval-20261108/)
- [61건 비교 결과](local-privacy-eval-20261108/compare-61/)
- [진행 복구 브라우저 결과·이미지](resumable-conflict-qa/)

평가 JSON과 이미지는 내용을 바꾸지 않고 이동했습니다. 마스킹 스크립트는 별도 harness와 저장소·출력 경로를 명령 인수로 받는 재현 보조 자료입니다. 독립 실행 프로그램이나 제품 실행 경로는 아닙니다.
