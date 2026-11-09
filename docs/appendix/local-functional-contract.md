# Local collection and recovery contract

Date: 2026-11-08. Scope: Donggyun-owned local backend. This is the implementation specification and handoff contract for a bounded change, not a claim of production rollout. EGM: the primary author retains project context; a fresh-context reviewer inspects this document and its source references independently. A single review does not establish full EGM loop convergence.

## Why and boundaries

The local collector owns durable private input, classification jobs, review candidates and frozen approved outbox records. The popup and web must display these records rather than maintain a second queue. Users need to distinguish review work from approved delivery, and recover quarantined input without overwriting evidence or implicitly sharing it.

Modify `integration.py`, `integration_store.py` and the unresolved-issue query in the owned `app.py` local review screen. That code now lives in the turn pipeline stage modules (`turn_intake.py`, `batch_queue.py`, `batch_classification.py`, `collection_status.py`, `candidate_review.py`, `local_rpc.py`), `pipeline_schema.py` and `review_render.py`. Create `check_local_functional.py`, `check_local_functional_http.py` and this document. No deletions, dependencies, configuration flags or public team-server schema changes. Preserve the existing AI, Decisions, web, extension, shared types, `delivery.py`, `team_client.py`, `native_host.py` and `prepare_native.py` implementations.

## Interfaces and invariants

### Collection status (`collection_status.collection_status`, RPC `collection.status`)

Existing fields remain. `bufferedTurns` counts only unassigned messages of the active team and current collection session. Group messages by stored `site:conversationId`, preserve row order inside each group, and sum existing `group_turns` results. It must not merge two sites or interleaved conversations. Old-session input remains stored but is not counted as currently flushable work. `lastCollectedAt` is the ISO time of the latest accepted intake row in that session, even before classification completes; null if none. It is local receipt time, not source-authored time. `recent` remains completed batches and is independent.

New `counts` keys:

| Key | Definition |
| --- | --- |
| reviewPending | Current-team, non-dismissed integrated cards with `cards.status=ready` |
| deliveryPending | Current-team, non-dismissed integrated cards with `outbox.state=pending`, including automatic retry backoff |
| deliveryBlocked | Same selection with `outbox.state=blocked`; explicit retry needed |
| classificationPending | Current-team/current-session jobs in `new`; includes jobs currently processing because the existing local worker has no separate running state. Batches the privacy gate holds are counted in `privacyHeld` instead ([local-privacy-gate.md](local-privacy-gate.md)) |
| classificationFailed | Current-team jobs in `failed_new`, including earlier sessions eligible for explicit retry |
| intakeIssues | Current-team quarantined issues without a resolution |

These are local queue counts, not a fresh team authorization check or Decisions results. `profileStatus=cached` remains. Legacy candidates remain represented by the existing `legacyCandidates` field, not these integrated card counts. `intakeIssues` status entries contain only id/reason/received, not raw input.

### Candidates (`candidate_review.list_candidates`, RPC `candidates.list`)

Keep current-team, non-dismissed, not-shared selection and existing `status=candidate`/`deliveryState`. Add `reviewState=review` for ready cards, otherwise `delivery`; `deliveryDetail`, `deliveryAttempts`, `nextDeliveryAttemptAt` come from the existing outbox and are null before approval. The last field is Unix seconds; 0 means immediately eligible, not a calendar date to display. Detail is the existing sanitized delivery error. A pending backoff is not a new review candidate. A blocked item may be retried; a sent item leaves this list.

### Quarantine recovery (`turn_intake.resolve_intake`)

Existing `intake.issues {}` now returns only unresolved issues of the current team. Its raw `message` encoding remains backward compatible: the database stores a JSON string containing the masked serialized original input. This local authenticated endpoint is not a public/team endpoint; never send its payload to the team server or logs. Resolved rows remain in SQLite; there is no new public history API in this change.

New methods:

* `intake.retry {id, teamId, message}`: require string id/teamId and a current-team issue. Require active collection. Validate the supplied corrected message using the same `clean_message` rules as `turns.append`: required nonempty string id/text/conversationId/site/role/collectedAt, text up to 20,000 characters, other required strings up to 1,200; supported incoming sites chatgpt/manual/chatgpt-export; user/assistant role; timezone-bearing ISO timestamp; optional boolean roleGuessed. Discard extra fields. UI correction of a local Codex/Claude issue must submit site=manual. Generate `id=intake-retry-<issue id>` and force site=manual, marking correction as manual input. Preserve supplied conversationId, role and timestamp. The original quarantine row links the new input to the rejected source. Apply the existing masker through `store_messages`. Queue exactly this one correction immediately via `queue_batch` with trigger=manual; do not flush unrelated pending input. A recovered candidate still requires explicit approval and existing evidence/role checks.
* `intake.dismiss {id, teamId}`: current-team issue required; allowed while paused/ended since this does not collect/classify/share. Record dismissal without deleting the original.
* Both return `{ok:true, alreadyResolved:false, replacementId:string|null}`. A repeated same-action request returns the prior result with `alreadyResolved:true` and does not process any new supplied body. Replacing an already resolved correction requires a new explicit input, not a replay of this request. Opposite action, missing issue, wrong/stale team, invalid correction or paused retry raises ValueError; existing HTTP wrapper returns 400. No automatic retry or alternate team fallback.

Schema: additive `intake_resolutions(issue_id PRIMARY KEY REFERENCES intake_issues(id), action CHECK retry/dismiss, replacement_id, resolved)` in `pipeline_schema.ensure_pipeline_schema`, created before its existing early return. Existing records, issue JSON, approval payloads and original inputs are retained. No schema-version change: this follows the existing idempotent integration migration. `TurnPipeline.write()` (the pipeline lock plus `BEGIN IMMEDIATE`) makes corrected intake, its job and resolution one transaction. Queue failure rolls all three back. The resolution key makes repeated/concurrent requests produce at most one replacement. `batch_queue.queue_batch` is the same step ordinary batching uses (`queue_ready_batches`); ordinary classification semantics remain.

### Truthful retries (`local_rpc.dispatch`)

Both retry methods require a nonempty string id; teamId, when provided, must also be a nonempty string. Invalid types/empty values are rejected before database access.

`jobs.retry {id, teamId?}` accepts only a failed_new job of the currently selected team; collection must be active. Under one immediate transaction, revalidate team/session, set context.collectionStart to the current session (existing recovery behavior), then state=new/detail empty. Pending, done, missing or other-team jobs fail instead of returning queued. Existing callers without teamId remain compatible; new callers should always send the viewed teamId to reject stale views.

`delivery.retry {id, teamId?}` accepts only blocked outbox rows whose frozen API/user/team destination matches the current binding. If teamId is supplied it must match. Exactly one updated row is required; otherwise fail. Reset state=pending/attempts=0/next_attempt=0/detail empty, preserving approved payload, timestamp and destination. It does not require active collection. The actual publish still authenticates against the team server; this local reset is not remote authorization. Both return `{queued:true}` only when a transition occurred. In integrated mode the review page's `/retry` and `/retry-delivery` forms (`review_page.py`) call these same two methods.

## Side effects and security boundaries

Status/candidate/issue reads are local SQLite reads and perform no network calls. Recovery writes local private rows and queues classification; it does not call the model synchronously or publish. The existing worker later calls the existing classifier. No new credential handling. Existing local HTTP Bearer authentication and Native Messaging extension-origin check remain. Approval still performs fresh membership validation and freezes the target; team storage excludes local evidence.

Known boundary at the time: the Python AI masker did not cover API keys/Bearer tokens. `ai/syncup_ai/mask.py` now does, checked against `shared/mask-cases.json`. This change did not weaken evidence validation. Only synthetic input may be used for the present verification; real sensitive conversation readiness is not claimed. Ha-eun must coordinate mask/evidence behavior; Donggyun must subsequently validate every collection path. Danbi must wire the new fields and RPCs into web/popup/shared types and publish matching extension assets. The review page's issue display (`review_render.py`) uses the same unresolved-only query (`turn_intake.unresolved_issues`); resolved original rows remain in the private database.

## Validation and rollout

Phase 1: implement schema and local contracts; run `python -m unittest check_local_functional.LocalFunctional check_pipeline check_local_recovery check_pipeline_schema check_integrity -v`. New tests cover mixed-source/interleaved/session counts, delivery separation, preserved quarantine/original input, repeated/restarted/concurrent correction, rollback, pause/team boundaries, truthful retries. Existing checks protect approval atomicity, migration, locks, HTTP recovery and offline intake. `local_fixtures.AI` is a deterministic fixture, not AI quality evidence.

Phase 2: on macOS, run `python check_local_functional_http.py` using the existing psycopg environment and Docker. `prepare_native.prepare` is macOS-only; this test is not portable to Linux/Windows. It reuses `check_teams.TeamIsolation`/`running_server`: temporary PostgreSQL 17 with restricted API role and RLS, actual local HTTP, synthetic users/tokens, no production DB. Creates a temporary native-host manifest, invokes its executable with real framed stdin/stdout, recovers input, classifies via deterministic AI, approves, observes failed delivery and retries, then verifies another authorized team member can read and a different-team user is rejected. The container and servers are cleaned by fixture teardown. Chrome browser installation/UI is not covered. No live Decisions request.

Phase 3: fresh-context source/document review; resolve findings and record them. Apply only the three owned source changes and three new files back to the active source tree after baseline-hash checks and safe-edit snapshots. Preserve the active Decisions branch and every other source file. No commit, push, deployment or frontend migration. Retain baseline and isolated work branch so the delta is reviewable. Report verified backend behavior separately from pending browser integration.
