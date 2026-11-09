"""싱크업 AI 파트 (백엔드 A · 김하은): 분류 프롬프트, 카드 JSON 정리, 결정 충돌 판정.

표준 라이브러리만 사용한다. 로컬 수집기와 팀 서버는 이 패키지를 같은 프로세스에서 import 해 쓰고,
명령줄 `python -m syncup_ai <명령>` 은 같은 함수를 JSON stdin/stdout 으로 부른다 (README 참고).
"""
