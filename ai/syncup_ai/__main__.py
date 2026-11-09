"""명령줄: JSON 을 stdin 으로 받아 stdout 으로 돌려준다.

  python -m syncup_ai classify   < NativeClassifyRequest   → NativeClassifyResponse
  python -m syncup_ai conflicts  < {newCards, existing}    → {ok, results, conflicts}
  python -m syncup_ai batch      < {messages, flush?}      → {batches, leftover}
  python -m syncup_ai prompt     < NativeClassifyRequest   → AI 에 보낼 프롬프트 (API 호출 없음)
"""
import json
import sys

from . import batch, classify, conflict
from .config import load_env
from .llm import LLMNotConfigured, decider_from_env, from_env


def main() -> int:
    load_env()
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    req = json.load(sys.stdin)

    if cmd == "classify":
        try:
            res = classify.handle_request(req, from_env(), decider_from_env())
        except LLMNotConfigured as e:
            res = {"ok": False, "error": str(e)}
    elif cmd == "conflicts":
        try:
            llm = from_env()
        except LLMNotConfigured:
            llm = None  # 규칙 판정으로
        res = conflict.handle_request(req, llm, decider_from_env())
    elif cmd == "batch":
        batches, leftover = batch.take_ready_batches(req.get("messages") or [], flush=bool(req.get("flush")))
        res = {"batches": batches, "leftover": leftover}
    elif cmd == "prompt":
        sys.stdout.write(classify._system_prompt() + "\n\n=====\n\n")
        sys.stdout.write(classify.build_user_prompt(req.get("context") or {}, req.get("messages") or [], req.get("contextMessages"))[0] + "\n")
        return 0
    else:
        print(__doc__, file=sys.stderr)
        return 2
    json.dump(res, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if res.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
