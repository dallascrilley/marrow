import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeWorkflowDraft } from "../dist/workflow/draft.js";

const runtimeOverrideEnvVar = "MARROW_ROOT";

function candidate(overrides = {}) {
  return {
    artifact_kind: "rule",
    candidate_id: "wf_testdraft",
    cluster: "validation",
    confidence: "strong",
    contradicting_count: 0,
    evidence_count: 1,
    evidence_sessions: [
      {
        asd_session_id: "draft-session",
        evidence_kind: "explicit_preference",
        excerpt: "Always run verification before final summary.",
        matched_rule_id: "validation-explicit-verify",
        source_tool: "cursor",
        topic: "Draft fixture",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ],
    guidance: "Run the relevant verification before claiming behavior works or work is complete.",
    recommendation: "adopt",
    risk: "low",
    rule_id: "validation-explicit-verify",
    supporting_count: 1,
    trigger: "Before claiming completion, merge readiness, or CI status.",
    ...overrides,
  };
}

test("writeWorkflowDraft writes markdown and apply report", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-workflow-draft-"));
  try {
    process.env[runtimeOverrideEnvVar] = sandbox;
    const result = await writeWorkflowDraft(candidate(), "rule");

    assert.equal(result.candidate_id, "wf_testdraft");
    assert.equal(result.target, "rule");
    assert.equal(result.dry_run, true);
    assert.equal("validation_flags" in result, false);

    const draft = await readFile(result.draft_path, "utf8");
    assert.match(draft, /## Trigger/);
    assert.match(draft, /## Guidance/);
    assert.match(draft, /Run the relevant verification before claiming behavior works/);

    assert.doesNotMatch(draft, /^# Injected/m);
    const report = JSON.parse(await readFile(result.apply_report_path, "utf8"));
    assert.equal(report.draft_path, result.draft_path);
    assert.equal("validation_flags" in report, false);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("writeWorkflowDraft sanitizes trigger and evidence markdown", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-workflow-draft-sanitize-"));
  try {
    process.env[runtimeOverrideEnvVar] = sandbox;
    const result = await writeWorkflowDraft(
      candidate({
        trigger: "# Injected\nBefore claiming completion",
        evidence_sessions: [
          {
            ...candidate().evidence_sessions[0],
            excerpt: "**Verified:** Always run verification before final summary.",
          },
        ],
      }),
      "rule",
    );

    const draft = await readFile(result.draft_path, "utf8");
    assert.doesNotMatch(draft, /^# Injected/m);
    assert.doesNotMatch(draft, /\*\*/);
    assert.match(draft, /Before claiming completion/);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("writeWorkflowDraft refuses quality-failing guidance", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-workflow-draft-invalid-"));
  try {
    process.env[runtimeOverrideEnvVar] = sandbox;
    await assert.rejects(
      writeWorkflowDraft(candidate({ guidance: "Summary: tests pass" }), "rule"),
      /raw_prefix, transient_or_validation_detail/,
    );
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});
