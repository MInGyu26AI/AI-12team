"""One entry point for the repository checks, grouped by what they need and what they cover.

    python3 run_checks.py            # local group (no Docker, no Rust build, no local model)
    python3 run_checks.py team rust  # several groups
    python3 run_checks.py all        # every group except the opt-in model measurements
    python3 run_checks.py --list     # which check covers which part, without running anything

Every check in the selected groups runs even after a failure; the exit code is non-zero if any failed.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PY = sys.executable

# (group, command, what it covers). Groups: local = macOS (check_integrity starts `app.py run`, which only runs on macOS),
# Python 3 and Node with `npm ci` in web/ and extension/ (check_local_bridge starts Next from web/node_modules; the unit
# tests run with each project's own runner); rust = needs the built scanner (bin/syncup-collector); team = needs Docker and
# requirements-team.txt (PostgreSQL); model = opt-in, needs Ollama with the default privacy model (privacy_model.DEFAULT_MODEL).
CHECKS: list[tuple[str, list[str], str]] = [
    ('local', [PY, 'check_pipeline.py'], '로컬 수집·배치·후보 저장·팀 요청 중계'),
    ('local', [PY, 'check_pipeline_schema.py'], '로컬 DB 마이그레이션·승인 계약·TS 공용 상수'),
    ('local', [PY, 'check_retention.py'], '원문·백업 7일 보존 정책'),
    ('local', [PY, 'check_local_privacy.py'], '로컬 개인정보 필터·외부 전송 차단'),
    ('local', [PY, 'check_privacy_holds.py'], '개인정보 보류·사용자 제외·재검사(실패 시 전송 없음)'),
    ('local', [PY, 'check_privacy_model_client.py'], '로컬 개인정보 모델 연결(루프백·엄격한 JSON·캐시)'),
    ('local', [PY, 'check_masking_integration.py'], '가림 → 근거 → 수정 → 승인 내용'),
    ('local', [PY, 'check_form_retry.py'], 'HTTP 재시도 계약'),
    ('local', [PY, 'check_local_functional.py'], '로컬 대기열·입력 정정'),
    ('local', [PY, 'check_local_recovery.py'], '오프라인 입력·거절·진단'),
    ('local', [PY, 'check_watch_paths.py'], '수집 루프 경로(표준·호환·비통합)'),
    ('local', [PY, 'check_response_disconnect.py'], '응답 유실 시 RPC 오류 중복 방지'),
    ('local', [PY, 'check_integrity.py'], '로컬 앱 회귀(격리 SQLite·루프백 HTTP·자식 프로세스)'),
    ('local', ['node', 'check_local_bridge.cjs'], '웹 ↔ 로컬 수집기 연결(쿠키·출처·RPC)'),
    ('local', ['node', 'check_mask_cases.cjs'], '가림 공용 사례: TypeScript 사본'),
    ('local', ['npm', '--prefix', 'web', 'test', '--silent'], '웹 단위 시험 (공유 폴러·승인함·/api/local 실패 응답)'),
    ('local', ['npm', '--prefix', 'extension', 'test', '--silent'], '확장 단위 시험 (메시지 응답·신뢰 주소·자동 수집·ChatGPT 추출)'),
    ('local', [PY, '-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'], 'AI 모듈 (가림 공용 사례 Python 쪽 포함)'),
    ('rust', [PY, 'check_scanner.py'], 'Rust 스캐너: Codex 로그'),
    ('rust', [PY, 'check_claude.py'], 'Rust 스캐너: Claude Code 로그'),
    ('rust', [PY, 'check_portability.py'], 'Rust 스캐너: 경로·OS 이식성'),
    # ServerRecovery inherits TeamIntegration (check_team_integration.py), which inherits TeamIsolation (check_teams.py),
    # so this one file runs all three suites once. Every other team file runs only its own tests (check_teams.own_tests).
    ('team', [PY, 'check_server_recovery.py'], '팀 격리(RLS) + 로컬 ↔ 팀 서버 통합 + 서버 복구 (상속으로 함께 실행)'),
    ('team', [PY, 'check_resumable_conflicts.py'], '충돌 검사 재개·재시작'),
    ('team', [PY, 'check_db_connection_recovery.py'], 'DB 연결 시간 초과·복구'),
    ('team', [PY, 'check_db_operations.py'], 'DB 업그레이드·백업·복원'),
    ('team', [PY, 'check_cloud_server.py'], '클라우드 HTTP 경계'),
    ('team', [PY, 'check_minimal_diagnostics.py'], '진단 기록 최소화'),
    ('team', [PY, 'check_local_functional_http.py'], '네이티브 → 로컬 RPC → PostgreSQL → 다른 팀원'),
    ('model', [PY, 'check_local_privacy_model.py'], '실제 로컬 모델 측정 (느림)'),
    ('model', [PY, 'check_privacy_memory_pipeline.py'], '실제 로컬 모델 → 필터 → 승인'),
]
GROUPS = ('local', 'rust', 'team', 'model')


def cwd_for(command: list[str]) -> Path:
    return ROOT / 'ai' if command[1:4] == ['-m', 'unittest', 'discover'] else ROOT


def main(argv: list[str]) -> int:
    if '--list' in argv:
        for group in GROUPS:
            print(f'[{group}]')
            for g, command, covers in CHECKS:
                if g == group:
                    print(f"  {' '.join(command[1:]) if command[0] == PY else ' '.join(command):55} {covers}")
        return 0
    wanted = set(argv) or {'local'}
    if 'all' in wanted:
        wanted = {'local', 'rust', 'team'}
    unknown = wanted - set(GROUPS)
    if unknown:
        print(f"알 수 없는 묶음: {', '.join(sorted(unknown))} (사용 가능: {', '.join(GROUPS)}, all)", file=sys.stderr)
        return 2
    results = []
    for group, command, covers in CHECKS:
        if group not in wanted:
            continue
        name = ' '.join(command[1:]) if command[0] == PY else ' '.join(command)
        started = time.monotonic()
        try:
            done = subprocess.run(command, cwd=cwd_for(command), capture_output=True, text=True)
        except OSError as error:  # missing or unrunnable executable: count it as a failed check and keep going
            done = subprocess.CompletedProcess(command, 127, '', f'실행할 수 없어요: {error.filename or command[0]} ({type(error).__name__})')
        elapsed = time.monotonic() - started
        results.append((done.returncode == 0, name))
        print(f"{'PASS' if done.returncode == 0 else 'FAIL'}  [{group}] {name}  ({elapsed:.1f}s)")
        if done.returncode == 0 and group == 'model' and done.stdout.strip():  # measurements: show the summary line
            print('      ' + done.stdout.strip().splitlines()[-1])
        if done.returncode != 0:
            print('\n'.join('      ' + line for line in (done.stdout + done.stderr).strip().splitlines()[-15:]))
    failed = [name for ok, name in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} 통과' + (f", 실패: {', '.join(failed)}" if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
