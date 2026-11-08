"""Run Codex's 12-route masking harness on the gate branch, without editing the harness.

The on-device classifier is replaced by an all-work stub, so this measures the format-rule stage
plus the outbound check on every route. It says nothing about semantic (model) quality.
"""
import importlib.util, json, os, subprocess, shutil, sys
from collections import Counter
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

harness_path, repo, output = Path(sys.argv[1]), Path(sys.argv[2]).resolve(), Path(sys.argv[3])
assert not output.exists()
spec = importlib.util.spec_from_file_location('masking_harness', harness_path)
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
h.self_check()
inputs = h.fixtures()
env = {k: os.environ[k] for k in ('PATH', 'LANG', 'TMPDIR') if k in os.environ}
adapted = subprocess.run([shutil.which('node'), str(harness_path.with_name('adapters.cjs')), str(repo)],
                         input=json.dumps(inputs), text=True, capture_output=True, env=env, timeout=60)
assert adapted.returncode == 0, 'TypeScript adapter failed'
adapters = json.loads(adapted.stdout)
sys.path.insert(0, str(repo))

class WorkOnly:
    def identity(self): return 'test:work-only'
    def classify(self, text): return dict(label='work', personal=[])

with ExitStack() as stack:
    stack.enter_context(patch.dict(os.environ, {}, clear=True))
    for target in ('socket.socket.connect', 'socket.socket.connect_ex', 'socket.create_connection', 'socket.getaddrinfo'):
        stack.enter_context(patch(target, side_effect=AssertionError('network prohibited')))
    stack.enter_context(patch('urllib.request.urlopen', side_effect=AssertionError('unexpected HTTP')))
    import integration, storage, local_privacy
    from ai.syncup_ai import llm
    stack.enter_context(patch.object(integration, 'load_env', return_value=None))
    stack.enter_context(patch.object(llm, 'decider_from_env', side_effect=AssertionError('Decisions prohibited')))
    stack.enter_context(patch.object(llm.DecisionsClient, 'decide', side_effect=AssertionError('Decisions prohibited')))
    stack.enter_context(patch.object(local_privacy, 'classifier_from_env', side_effect=WorkOnly))
    # Mutation probe: with every masking layer and the outbound check disabled, the harness must FAIL.
    probe = inputs[0]
    identity = lambda text: (text, False)
    with patch.object(integration, 'mask', side_effect=identity), patch('ai.syncup_ai.classify.mask', side_effect=identity), \
         patch.object(local_privacy, 'apply_rules', side_effect=lambda t: (t, [])), \
         patch.object(local_privacy, 'secret_values', return_value=[]):
        assert h.run_route('intake_recovery', probe, {}, integration, storage, llm)['status'] == 'FAIL'
    # Outbound check alone (rules disabled) must stop the request: no capture -> harness ERROR, not a leak.
    with patch.object(local_privacy, 'apply_rules', side_effect=lambda t: (t, [])):
        try:
            outcome = h.run_route('automatic_rpc', probe, {}, integration, storage, llm)['status']
        except AssertionError:
            outcome = 'NO_REQUEST'
        assert outcome == 'NO_REQUEST', outcome
    rows = []
    for f in inputs:
        for route in h.ROUTES:
            try:
                rows.append(h.run_route(route, f, adapters['results'][f['id']], integration, storage, llm))
            except Exception as error:
                rows.append(dict(route=route, fixture=f['id'], status='ERROR', error_type=type(error).__name__))
counts = dict(Counter(r['status'] for r in rows))
report = dict(scope='Codex 12-route harness on claude/local-privacy-gate-20261108; classifier=all-work stub (rule stage only)',
              counts=counts, rows=rows, probes='mutation FAIL detected; outbound check alone blocks the request')
output.write_text(json.dumps(report, ensure_ascii=False, indent=1))
print(counts)
print(sorted({(r['route'], r['fixture'], r['status']) for r in rows if r['status'] != 'PASS'}))
