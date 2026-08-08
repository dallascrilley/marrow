# Demo transcript 2026-08-08

## 1 ready
ready_count 7
- asd-kjl open Unify pipeline, recall, and storage health for operators
- asd-rxz open External staging storage
- asd-t5s open docs: public tracking demo for beads multi-tracker workflow
- asd-rxz.1 open U5: Optional S3 cold-tier offload and restore
- asd-kjl.1 open H3: Surface shared health and recall delivery in the static dashboard
- asd-6wv open Extraction polish backlog: text-normalizer edge cases + rereduce CLI e
- asd-6j9 open Minor extraction/summary polish backlog from compression review

## 2 claim polish
claim=asd-6wv
asd-6wv in_progress

## 3 discover
discovery=asd-diq
deps [{'id': 'asd-6wv', 'title': 'Extraction polish backlog: text-normalizer edge cases + rereduce CLI ergonomics', 'description': "Deferred LOW findings from fresh-eyes review of PR #148/#149: (1) headingPreferenceFragmentPattern misses hyphenated left sides ('type-safe code — always'); (2) stripLeadingElision leaves stray dot on '....'; (3) normalizeFixSummary strips elision after completion-verb strip ('...completed updated X' keeps 'completed'); (4) subtractDuplicateLines only subtracts capped 10 failures, failure #11+ can reappear in decisions (documented tradeoff); (5) rereduce typo'd --session-id silently exits rc=0 with matched_count 0 (matches reextract convention — reconsider both); (6) reducers/event-tagging.ts importing from ../pipeline/extract/ is a layering smell (no cycle); (7) README rereduce row omits that ready sessions get parsed intermediates retired during the run; (8) archive rewrites summary on every run (mtime churn); (9) duplicate focus excerpt when identical assistant text anchors two lines (cosmetic).\n\n---\nMigrated from td-626d72 on 20260808T044110Z", 'notes': 'points: 0', 'status': 'in_progress', 'priority': 4, 'issue_type': 'task', 'assignee': 'dallascrilley', 'owner': 'dallas@dallascrilley.com', 'created_at': '2026-08-08T04:41:23Z', 'created_by': 'dallascrilley', 'updated_at': '2026-08-08T04:43:37Z', 'started_at': '2026-08-08T04:43:37Z', 'labels': ['ideas', 'legacy:td-626d72', 'migrated-from-td'], 'dependency_type': 'discovered-from'}]
parent None

## 4 linear epic dry-run note (bd linear push broken on 1.1.2 custom states; epics pre-linked via API)
epic_count 4 with_ref 4
discovery has linear ref? False
micro-task still beads-local: OK

## 5 promote feature sample (optional dry) — skip create on Linear for blocked features; show epic refs
asd-3by https://linear.app/dallascrilley/issue/AGE-54/enforce-audit-backed-agent-rules-s
asd-mvb https://linear.app/dallascrilley/issue/AGE-55/close-the-distillery-feedback-loop
asd-kjl https://linear.app/dallascrilley/issue/AGE-56/unify-pipeline-recall-and-storage-
asd-rxz https://linear.app/dallascrilley/issue/AGE-57/external-staging-storage
asd-t5s gh-156

## 6 gh-linked public bead
asd-t5s gh-156 docs: public tracking demo for beads multi-tracker workflow

## 7 block claim briefly then unblock for cleanliness
ready after block (should exclude claim):
['asd-kjl', 'asd-rxz', 'asd-diq', 'asd-t5s', 'asd-rxz.1', 'asd-kjl.1', 'asd-6j9']
claim_in_ready False

## 8 close discovery
asd-diq closed

## 9 final ready count
ready 7
total 15 Counter({'open': 7, 'in_progress': 5, 'blocked': 3})

## PASS criteria checklist
- [x] No td writes in demo
- [x] Linear epics linked (AGE-54..57); micro discovery not on Linear
- [x] GH public bead asd-t5s / gh-156
- [x] Ready excludes blocked
- [x] Discovery create+close via beads only
