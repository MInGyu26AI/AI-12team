# 평가 데이터 넣는 곳

민규 님 파일을 이 폴더에 아래 이름 그대로 넣는다 (.xlsx 그대로 OK).

- `sample_conversations_v1.csv.xlsx` — 샘플 대화
- `answer_key_v1.csv.xlsx` — 분류 정답표
- `conflict_key_v1.csv.xlsx` — 충돌 정답표

이 폴더의 데이터 파일은 `.gitignore` 로 커밋되지 않는다 (팀 레포가 Public).
평가 도구는 로컬 개인정보 게이트 없이 형식 가림만 하고 외부 AI 로 보낸다 (docs/privacy.md). 그래서 여기에는
지어낸 샘플·합성 대화만 넣고 실제 팀원 대화는 넣지 않는다.

`python3 -m eval.synth` 가 만드는 합성 대화 `synth_conversations.csv`·`synth_answer_key.csv`·`synth_conflict_key.csv` 도
여기 생긴다. `syntitan_answer_key*.csv` 는 SynTitan Ready for Raw Data 에 올린 정답표 사본이다 (eval/syntitan/README.md).

넣은 뒤 `python3 -m eval.sheets` 로 컬럼 이름을 확인한다. `eval/sheets.py` 의 컬럼 주석(민규 님 v1 기준)과 같아야 한다.
