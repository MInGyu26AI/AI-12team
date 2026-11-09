# 평가 데이터 넣는 곳

민규 님 파일을 이 폴더에 아래 이름 그대로 넣는다 (.xlsx 그대로 OK).

- `sample_conversations_v1.csv.xlsx` — 샘플 대화
- `answer_key_v1.csv.xlsx` — 분류 정답표
- `conflict_key_v1.csv.xlsx` — 충돌 정답표

이 폴더의 데이터 파일은 `.gitignore` 로 커밋되지 않는다 (팀 레포가 Public).
실제 팀원 대화라 이름·연락처가 들어 있을 수 있으니, 커밋하려면 먼저 확인하고 `.gitignore` 에서 해당 파일만 빼기.

넣은 뒤 `python3 -m eval.sheets` 로 컬럼 이름을 확인한다. `eval/sheets.py` 의 컬럼 주석(민규 님 v1 기준)과 같아야 한다.
