// 수집 묶음 크기(대화 N회마다 분류). 실제 묶기는 로컬 수집기(ai/syncup_ai/batch.py)가 한다.
// 질문 + 답변 = 1회. 값은 config.TURNS_PER_BATCH, 범위는 integration.py configure 와 같다.
export const TURNS_PER_BATCH = 10;
export const MAX_TURNS_PER_BATCH = 50;
