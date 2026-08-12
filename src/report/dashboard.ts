import type { LifecycleState } from "../db/queries.js";
import type { QualityAuditReport, QualityIssueCode } from "../pipeline/quality-audit.js";
import type { HarnessBreakdownSnapshot } from "../read/harness-breakdown.js";
import type { KnowledgeSnapshot } from "../read/knowledge.js";
import type { PipelineStatus } from "../read/operations.js";
import type { OperatorHealthModel } from "../read/operator-health.js";
import type { SessionDetail } from "../read/session-detail.js";

export type DashboardSession = {
  detail: SessionDetail;
  lifecycle_state: LifecycleState;
  quality_audit: {
    issue_count: number;
    issues: QualityIssueCode[];
  } | null;
};

export type DashboardQualityAudit = {
  deletion_readiness: QualityAuditReport["deletion_readiness"];
  indexed_with_issues: number;
  issue_counts: Partial<Record<QualityIssueCode, number>>;
  totals: QualityAuditReport["totals"];
};

export type DashboardQualityAuditBundle = {
  audit: DashboardQualityAudit;
  by_session_id: Record<string, DashboardSession["quality_audit"]>;
};

export function buildDashboardQualityAudit(
  report: QualityAuditReport,
  sessionIds: readonly string[],
): DashboardQualityAuditBundle {
  const wanted = new Set(sessionIds);
  const bySessionId: Record<string, DashboardSession["quality_audit"]> = {};
  for (const session of report.sessions) {
    if (!wanted.has(session.session_id) || session.issues.length === 0) {
      continue;
    }
    bySessionId[session.session_id] = {
      issue_count: session.issue_count,
      issues: session.issues,
    };
  }

  const issue_counts: Partial<Record<QualityIssueCode, number>> = {};
  for (const [code, count] of Object.entries(report.issue_counts) as Array<
    [QualityIssueCode, number]
  >) {
    if (count > 0) {
      issue_counts[code] = count;
    }
  }

  return {
    audit: {
      deletion_readiness: report.deletion_readiness,
      indexed_with_issues: 0,
      issue_counts,
      totals: report.totals,
    },
    by_session_id: bySessionId,
  };
}

export type DashboardReviewItem = {
  current_lifecycle_state: LifecycleState;
  enqueued_at: string;
  project_key: string;
  queue_state: string;
  reason: string;
  review_kind: string;
  session_id: string;
  updated_at: string;
};

export type DashboardData = {
  generated_at: string;
  harness_breakdown: HarnessBreakdownSnapshot;
  knowledge_snapshot: KnowledgeSnapshot;
  operator_health: OperatorHealthModel;
  pipeline_status: PipelineStatus;
  quality_audit: DashboardQualityAudit;
  review_items: DashboardReviewItem[];
  sessions: DashboardSession[];
  stats: {
    source_tools: Record<string, number>;
    topic_sources: Record<string, number>;
    total_sessions: number;
  };
};

export function buildDashboardData(
  sessions: readonly Omit<DashboardSession, "quality_audit">[],
  operatorHealth: OperatorHealthModel,
  knowledgeSnapshot: KnowledgeSnapshot,
  harnessBreakdown: HarnessBreakdownSnapshot,
  reviewItems: readonly DashboardReviewItem[],
  qualityAuditBundle: DashboardQualityAuditBundle,
): DashboardData {
  const sourceTools: Record<string, number> = {};
  const topicSources: Record<string, number> = {};

  const enrichedSessions: DashboardSession[] = sessions.map((session) => ({
    ...session,
    quality_audit: qualityAuditBundle.by_session_id[session.detail.index.asd_session_id] ?? null,
  }));

  const quality_audit: DashboardQualityAudit = {
    ...qualityAuditBundle.audit,
    indexed_with_issues: enrichedSessions.filter((session) => session.quality_audit !== null)
      .length,
  };

  for (const session of enrichedSessions) {
    sourceTools[session.detail.index.source_tool] =
      (sourceTools[session.detail.index.source_tool] ?? 0) + 1;
    topicSources[session.detail.index.topic_source] =
      (topicSources[session.detail.index.topic_source] ?? 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    harness_breakdown: harnessBreakdown,
    knowledge_snapshot: knowledgeSnapshot,
    operator_health: operatorHealth,
    pipeline_status: operatorHealth.pipeline.status,
    quality_audit: quality_audit,
    review_items: [...reviewItems].sort((left, right) => {
      const byTime = right.updated_at.localeCompare(left.updated_at);
      return byTime !== 0 ? byTime : left.session_id.localeCompare(right.session_id);
    }),
    sessions: [...enrichedSessions].sort((left, right) => {
      const byTime = right.detail.index.updated_at.localeCompare(left.detail.index.updated_at);
      return byTime !== 0
        ? byTime
        : left.detail.index.asd_session_id.localeCompare(right.detail.index.asd_session_id);
    }),
    stats: {
      source_tools: sourceTools,
      topic_sources: topicSources,
      total_sessions: enrichedSessions.length,
    },
  };
}

function escapeScriptJson(value: unknown): string {
  // Escape `<` so `</script` and `<!--` cannot appear in the JSON data — the
  // only sequences the HTML5 parser acts on inside a <script> block. Both
  // start with `<`, so escaping it covers both; JSON.parse restores it on read.
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// The aggregate sidebar panels only ever render these many entries; the rest
// of each array exists only to compute totals, which we precompute instead of
// shipping the full arrays. Kept in sync with the client renderers below.
const KNOWLEDGE_PROJECTS_SHOWN = 6;
const KNOWLEDGE_INSTINCTS_SHOWN = 8;
const REVIEW_ITEMS_SHOWN = 12;

function renderLazyAggregateBlock(kind: string, value: unknown): string {
  return (
    '<script type="application/json" class="marrow-aggregate" data-aggregate="' +
    escapeHtmlAttr(kind) +
    '">' +
    escapeScriptJson(value) +
    "</script>"
  );
}

export function renderDashboardHtml(data: DashboardData): string {
  // Split the payload so the page opens instantly regardless of corpus size:
  // the lightweight list is parsed eagerly, while each session's heavy detail
  // (summary + reduced timeline) ships as an inert <script type="application/json">
  // block that is JSON.parsed only on demand. Keeps a single offline file.
  const knowledge = data.knowledge_snapshot;
  const listData = {
    generated_at: data.generated_at,
    harness_breakdown: data.harness_breakdown,
    // Ship only the displayed entries plus precomputed counts; the full
    // projects/instincts arrays are multi-MB and never rendered past top-N.
    knowledge_snapshot: {
      total_learnings: knowledge.total_learnings,
      total_instincts: knowledge.total_instincts,
      projects_count: knowledge.projects.length,
      projects: knowledge.projects.slice(0, KNOWLEDGE_PROJECTS_SHOWN),
      instincts: knowledge.instincts.slice(0, KNOWLEDGE_INSTINCTS_SHOWN),
    },
    // The shared model owns lifecycle inventory, but its artifact list can be
    // large. Ship only the operator-facing storage rollup in the eager payload.
    operator_health: {
      reasons: data.operator_health.reasons,
      recall: data.operator_health.recall,
      recommendation: data.operator_health.recommendation,
      review: data.operator_health.review,
      status: data.operator_health.status,
      storage: {
        pressure: data.operator_health.storage.pressure,
        pressure_threshold_bytes: data.operator_health.storage.pressure_threshold_bytes,
        reclaimable_bytes: data.operator_health.storage.reclaimable_bytes,
        total: data.operator_health.storage.inventory.total,
      },
    },
    pipeline_status: data.pipeline_status,
    // Review queue can hold thousands of entries; ship only the displayed
    // slice plus precomputed totals the count card needs.
    review_items: data.review_items.slice(0, REVIEW_ITEMS_SHOWN),
    review_stats: {
      total: data.review_items.length,
      kinds: new Set(data.review_items.map((item) => item.review_kind)).size,
      projects: new Set(data.review_items.map((item) => item.project_key)).size,
    },
    quality_audit: data.quality_audit,
    lazy_aggregates: {
      knowledge_instincts: knowledge.instincts.length > KNOWLEDGE_INSTINCTS_SHOWN,
      knowledge_projects: knowledge.projects.length > KNOWLEDGE_PROJECTS_SHOWN,
      review_items: data.review_items.length > REVIEW_ITEMS_SHOWN,
    },
    sessions: data.sessions.map((session) => ({
      // Only the fields the sidebar list, filters, and search read — not the
      // full index record (its absolute paths / uuid never reach the client).
      index: {
        asd_session_id: session.detail.index.asd_session_id,
        topic: session.detail.index.topic,
        topic_source: session.detail.index.topic_source,
        next_step: session.detail.index.next_step,
        source_tool: session.detail.index.source_tool,
        updated_at: session.detail.index.updated_at,
      },
      lifecycle_state: session.lifecycle_state,
      summary_topic: session.detail.summary ? session.detail.summary.topic : null,
      quality_issues: session.quality_audit?.issues ?? [],
    })),
    stats: data.stats,
  };
  const payload = escapeScriptJson(listData);
  const detailBlocks = data.sessions
    .map(
      (session) =>
        '<script type="application/json" class="marrow-detail" data-session-id="' +
        escapeHtmlAttr(session.detail.index.asd_session_id) +
        '">' +
        escapeScriptJson({
          summary: session.detail.summary,
          reduced_turns: session.detail.reduced_turns,
        }) +
        "</script>",
    )
    .join("\n");
  const aggregateBlocks = [
    knowledge.projects.length > KNOWLEDGE_PROJECTS_SHOWN
      ? renderLazyAggregateBlock("knowledge-projects", knowledge.projects)
      : "",
    knowledge.instincts.length > KNOWLEDGE_INSTINCTS_SHOWN
      ? renderLazyAggregateBlock("knowledge-instincts", knowledge.instincts)
      : "",
    data.review_items.length > REVIEW_ITEMS_SHOWN
      ? renderLazyAggregateBlock("review-items", data.review_items)
      : "",
  ]
    .filter((block) => block.length > 0)
    .join("\n");

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    "    <title>Marrow Dashboard</title>",
    "    <style>",
    "      :root { color-scheme: dark; --bg: #0b1020; --panel: #121a2b; --panel-alt: #182238; --border: #26324a; --text: #e6edf7; --muted: #94a3b8; --accent: #60a5fa; --chip: #1e293b; }",
    "      * { box-sizing: border-box; }",
    '      body { margin: 0; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }',
    "      .layout { display: grid; grid-template-columns: minmax(360px, 480px) 1fr; min-height: 100vh; }",
    "      .sidebar, .detail { padding: 20px; }",
    "      .sidebar { border-right: 1px solid var(--border); background: linear-gradient(180deg, #0e1526 0%, #0b1020 100%); }",
    "      .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin-bottom: 16px; }",
    "      h1, h2, h3, p { margin-top: 0; }",
    "      .muted { color: var(--muted); }",
    "      .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }",
    "      .stat { background: var(--panel-alt); border-radius: 12px; padding: 12px; border: 1px solid var(--border); }",
    "      .stat strong { display: block; font-size: 1.3rem; }",
    "      .section-stack { display: grid; gap: 16px; }",
    "      .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }",
    "      .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }",
    "      .metric-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }",
    "      .metric-list li { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 6px 12px; background: var(--panel-alt); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }",
    "      .metric-list li > span { flex: 1 1 7rem; min-width: 0; overflow-wrap: anywhere; }",
    "      .metric-list strong { flex: 1 1 auto; max-width: 100%; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; word-break: break-word; }",
    "      .knowledge-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }",
    "      .knowledge-item { background: var(--panel-alt); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }",
    "      .knowledge-item p { margin-bottom: 0; overflow-wrap: anywhere; word-break: break-word; }",
    "      .stack { display: grid; gap: 12px; }",
    "      input, select { width: 100%; background: #0f172a; color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }",
    "      .session-list { display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 360px); overflow: auto; }",
    "      .session-card { background: var(--panel); color: inherit; border: 1px solid var(--border); border-radius: 12px; padding: 14px; text-align: left; cursor: pointer; }",
    "      .session-card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }",
    "      .session-card:hover { background: var(--panel-alt); }",
    "      .session-card h3 { margin-bottom: 8px; font-size: 1rem; }",
    "      .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }",
    "      .chip { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; font-size: 0.85rem; }",
    "      ul { margin: 0; padding-left: 18px; }",
    "      .turn { padding: 12px 0; border-top: 1px solid var(--border); }",
    "      .turn:first-child { border-top: 0; padding-top: 0; }",
    "      pre { white-space: pre-wrap; word-break: break-word; background: #09101d; border: 1px solid var(--border); border-radius: 10px; padding: 12px; }",
    "      .empty { color: var(--muted); font-style: italic; }",
    "      .drilldown-btn { background: var(--panel-alt); color: var(--accent); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; cursor: pointer; margin-top: 8px; }",
    "      .drilldown-btn:hover { background: var(--chip); }",
    "      @media (max-width: 980px) { .layout { grid-template-columns: 1fr; } .sidebar { border-right: 0; border-bottom: 1px solid var(--border); } .session-list { max-height: none; } }",
    "    </style>",
    "  </head>",
    "  <body>",
    '    <div class="layout">',
    '      <aside class="sidebar">',
    '        <div class="panel">',
    "          <h1>Marrow Dashboard</h1>",
    '          <p class="muted">Static offline report for ingested sessions.</p>',
    '          <div class="stats">',
    '            <div class="stat"><span class="muted">Sessions</span><strong id="stat-total"></strong></div>',
    '            <div class="stat"><span class="muted">Source tools</span><strong id="stat-tools"></strong></div>',
    '            <div class="stat"><span class="muted">Generated</span><strong id="stat-generated"></strong></div>',
    "          </div>",
    "        </div>",
    '        <div class="panel">',
    "          <h2>Operator health</h2>",
    '          <p class="muted">Shared read-only health, recall delivery, and pipeline snapshot from the current runtime.</p>',
    '          <div class="section-stack" id="operator-health"></div>',
    "        </div>",
    '        <div class="panel">',
    "          <h2>Quality audit</h2>",
    '          <p class="muted">Corpus rollup from quality-audit heuristics; per-session badges in the list.</p>',
    '          <div class="section-stack" id="quality-audit-view"></div>',
    "        </div>",
    '        <div class="panel">',
    "          <h2>Knowledge & instincts</h2>",
    '          <p class="muted">Merged project learnings and project instinct store snapshots with source back-links.</p>',
    '          <div class="section-stack" id="knowledge-view"></div>',
    "        </div>",
    '        <div class="panel">',
    "          <h2>Cross-harness comparison</h2>",
    '          <p class="muted">Volume, topic quality, learning yield, and LLM cost by normalized source harness.</p>',
    '          <div class="section-stack" id="harness-view"></div>',
    "        </div>",
    '        <div class="panel">',
    "          <h2>Review queue</h2>",
    '          <p class="muted">Read-only triage snapshot from the current review queue; act through CLI commands.</p>',
    '          <div class="section-stack" id="review-queue-view"></div>',
    "        </div>",
    '        <div class="panel">',
    '          <input id="search" type="search" placeholder="Search topic, id, next step" />',
    '          <select id="source-tool"></select>',
    '          <select id="lifecycle-state"></select>',
    '          <div class="session-list" id="session-list"></div>',
    "        </div>",
    "      </aside>",
    '      <main class="detail">',
    '        <div class="panel" id="detail"></div>',
    "      </main>",
    "    </div>",
    detailBlocks,
    aggregateBlocks,
    "    <script>",
    `      const data = ${payload};`,
    "      const detailNodes = new Map();",
    "      for (const node of document.querySelectorAll('script.marrow-detail')) { detailNodes.set(node.getAttribute('data-session-id'), node); }",
    "      const detailCache = new Map();",
    "      function getDetail(id) {",
    "        if (id === null || id === undefined) return { summary: null, reduced_turns: [] };",
    "        if (detailCache.has(id)) return detailCache.get(id);",
    "        const node = detailNodes.get(id);",
    "        let parsed;",
    "        try { parsed = node ? JSON.parse(node.textContent) : { summary: null, reduced_turns: [] }; }",
    "        catch { parsed = { summary: null, reduced_turns: [] }; }",
    "        detailCache.set(id, parsed);",
    "        return parsed;",
    "      }",
    "      const aggregateNodes = new Map();",
    "      for (const node of document.querySelectorAll('script.marrow-aggregate')) { aggregateNodes.set(node.getAttribute('data-aggregate'), node); }",
    "      const aggregateCache = new Map();",
    "      function getAggregate(kind) {",
    "        if (aggregateCache.has(kind)) return aggregateCache.get(kind);",
    "        const node = aggregateNodes.get(kind);",
    "        let parsed;",
    "        try { parsed = node ? JSON.parse(node.textContent) : null; }",
    "        catch { parsed = null; }",
    "        aggregateCache.set(kind, parsed);",
    "        return parsed;",
    "      }",
    "      let knowledgeProjectsExpanded = false;",
    "      let knowledgeInstinctsExpanded = false;",
    "      let reviewItemsExpanded = false;",
    "      const sessionList = document.getElementById('session-list');",
    "      const detail = document.getElementById('detail');",
    "      const operatorHealth = document.getElementById('operator-health');",
    "      const qualityAuditView = document.getElementById('quality-audit-view');",
    "      const knowledgeView = document.getElementById('knowledge-view');",
    "      const harnessView = document.getElementById('harness-view');",
    "      const reviewQueueView = document.getElementById('review-queue-view');",
    "      const searchInput = document.getElementById('search');",
    "      const sourceToolSelect = document.getElementById('source-tool');",
    "      const lifecycleStateSelect = document.getElementById('lifecycle-state');",
    "      let selectedSessionId = data.sessions[0] ? data.sessions[0].index.asd_session_id : null;",
    "      document.getElementById('stat-total').textContent = String(data.stats.total_sessions);",
    "      document.getElementById('stat-tools').textContent = String(Object.keys(data.stats.source_tools).length);",
    "      document.getElementById('stat-generated').textContent = new Date(data.generated_at).toLocaleDateString();",
    "      hydrateSelect(sourceToolSelect, 'All source tools', uniqueValues(data.sessions.map((session) => session.index.source_tool)));",
    "      hydrateSelect(lifecycleStateSelect, 'All lifecycle states', uniqueValues(data.sessions.map((session) => session.lifecycle_state)));",
    "      renderOperatorHealth();",
    "      renderQualityAuditView();",
    "      renderKnowledgeView();",
    "      renderHarnessView();",
    "      renderReviewQueueView();",
    "      searchInput.addEventListener('input', render);",
    "      sourceToolSelect.addEventListener('change', render);",
    "      lifecycleStateSelect.addEventListener('change', render);",
    "      render();",
    "      function render() {",
    "        const filtered = filterSessions();",
    "        renderSessionList(filtered);",
    "        const active = filtered.find((session) => session.index.asd_session_id === selectedSessionId) || filtered[0] || null;",
    "        selectedSessionId = active ? active.index.asd_session_id : null;",
    "        renderDetail(active, active ? getDetail(active.index.asd_session_id) : null);",
    "      }",
    "      function filterSessions() {",
    "        const needle = searchInput.value.trim().toLowerCase();",
    "        const tool = sourceToolSelect.value;",
    "        const lifecycle = lifecycleStateSelect.value;",
    "        return data.sessions.filter((session) => {",
    "          if (tool && session.index.source_tool !== tool) return false;",
    "          if (lifecycle && session.lifecycle_state !== lifecycle) return false;",
    "          if (!needle) return true;",
    "          const text = [session.index.asd_session_id, session.index.topic, session.index.next_step, session.lifecycle_state, session.summary_topic || '', ...(session.quality_issues || [])].join('\\n').toLowerCase();",
    "          return text.includes(needle);",
    "        });",
    "      }",
    "      function renderOperatorHealth() {",
    "        const health = data.operator_health;",
    "        const status = data.pipeline_status;",
    "        const events = health.recall.events;",
    "        const reachability = health.recall.reachability;",
    "        operatorHealth.innerHTML = '<div class=\"kpi-grid\">' +",
    "          renderMetricCard('Current status', [",
    "            { label: 'Status', value: health.status },",
    "            { label: 'Degraded reasons', value: health.reasons.length === 0 ? 'none' : health.reasons.join(', ') },",
    "            { label: 'Next action', value: health.recommendation.command },",
    "          ]) +",
    "          renderMetricCard('Recall delivery', [",
    "            { label: 'Delivered fires', value: events.fires_delivered + '/' + events.total_fires },",
    "            { label: 'Failed fires', value: health.recall.failed_fires },",
    "            { label: 'Last successful delivery', value: events.last_delivered_at || 'none recorded' },",
    "          ]) +",
    "          renderMetricCard('Recall reachability', [",
    "            { label: 'Project reachable', value: reachability.reachable + '/' + reachability.produced },",
    "            { label: 'Global reachable', value: reachability.global_reachable + '/' + reachability.global_produced },",
    "            { label: 'Project ratio', value: String(reachability.reachable_ratio) },",
    "          ]) +",
    "          renderMetricCard('Review state', [",
    "            { label: 'Freshness', value: health.review.freshness },",
    "            { label: 'Reviewed entries', value: health.review.reviewed.entry_count },",
    "            { label: 'Latest apply', value: health.review.latest_apply ? health.review.latest_apply.status : 'none recorded' },",
    "          ]) +",
    "          renderMetricCard('Storage', [",
    "            { label: 'Pressure', value: health.storage.pressure },",
    "            { label: 'Total', value: formatBytes(health.storage.total.bytes) },",
    "            { label: 'Reclaimable', value: formatBytes(health.storage.reclaimable_bytes) },",
    "          ]) +",
    "          '</div>' +",
    "          '<h3>Pipeline detail</h3>' +",
    "          '<div class=\"kpi-grid\">' +",
    "          renderMetricCard('Total sessions', [{ label: 'All sessions', value: status.totalSessions }]) +",
    "          renderMetricCard('Review queue', metricEntries(status.reviewQueue)) +",
    "          renderMetricCard('Deletion candidates', metricEntries(status.deletionCandidates)) +",
    "          '</div>' +",
    "          '<div class=\"metric-grid\">' +",
    "          renderMetricCard('Sessions by lifecycle', metricEntries(status.sessionsByLifecycle)) +",
    "          renderMetricCard('Blocked deletion reasons', metricEntries(status.blockedReasons)) +",
    "          '</div>';",
    "      }",
    "      function renderQualityAuditView() {",
    "        const audit = data.quality_audit;",
    "        const issueEntries = Object.entries(audit.issue_counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));",
    "        qualityAuditView.innerHTML = '<div class=\"kpi-grid\">' +",
    "          renderMetricCard('Audit totals', [",
    "            { label: 'Indexed sessions', value: String(data.stats.total_sessions) },",
    "            { label: 'Ledger audited', value: String(audit.totals.audited) },",
    "            { label: 'Indexed with issues', value: String(audit.indexed_with_issues) },",
    "            { label: 'Ledger with issues', value: String(audit.totals.with_issues) },",
    "          ]) +",
    "          renderMetricCard('Deletion readiness', metricEntries(audit.deletion_readiness)) +",
    "          '</div>' +",
    "          renderMetricCard('Issue codes (corpus)', issueEntries.map(([label, value]) => ({ label, value: String(value) })));",
    "      }",
    "      function renderKnowledgeView() {",
    "        const snapshot = data.knowledge_snapshot;",
    "        const projects = knowledgeProjectsExpanded ? (getAggregate('knowledge-projects') || snapshot.projects) : snapshot.projects;",
    "        const instincts = knowledgeInstinctsExpanded ? (getAggregate('knowledge-instincts') || snapshot.instincts) : snapshot.instincts;",
    "        knowledgeView.innerHTML = '<div class=\"kpi-grid\">' +",
    "          renderMetricCard('Knowledge totals', [",
    "            { label: 'Project learnings', value: String(snapshot.total_learnings) },",
    "            { label: 'Instincts', value: String(snapshot.total_instincts) },",
    "            { label: 'Projects', value: String(snapshot.projects_count) },",
    "          ]) +",
    "          '</div>' +",
    "          '<div class=\"metric-grid\">' +",
    "          renderKnowledgeCard('Projects', projects.map((project) => ({",
    "            title: project.project_id,",
    "            body: project.source + ' • ' + project.learnings.length + ' learnings',",
    "            chips: [project.source, project.learnings.length + ' learnings'],",
    "            links: project.learnings.slice(0, 2).map((learning) => learning.statement),",
    "          }))) +",
    `          renderDrilldownButton('knowledge-projects', knowledgeProjectsExpanded, snapshot.projects_count, ${KNOWLEDGE_PROJECTS_SHOWN}) +`,
    "          renderKnowledgeCard('Recent instincts', instincts.map((instinct) => ({",
    "            title: instinct.finding,",
    "            body: instinct.trigger,",
    "            chips: [instinct.domain, instinct.maturity, 'confidence ' + instinct.confidence],",
    "            links: instinct.source.source_refs.map((ref) => ref.path + ' (' + ref.session + ')').slice(0, 3),",
    "          }))) +",
    `          renderDrilldownButton('knowledge-instincts', knowledgeInstinctsExpanded, snapshot.total_instincts, ${KNOWLEDGE_INSTINCTS_SHOWN}) +`,
    "          '</div>';",
    "        bindDrilldownButtons(knowledgeView);",
    "      }",
    "      function renderHarnessView() {",
    "        const breakdown = data.harness_breakdown;",
    "        harnessView.innerHTML = '<div class=\"kpi-grid\">' +",
    "          renderMetricCard('Harness totals', [",
    "            { label: 'Harnesses', value: String(breakdown.by_source_tool.length) },",
    "            { label: 'Sessions', value: String(breakdown.totals.sessions) },",
    "            { label: 'Project learnings', value: String(breakdown.totals.project_learnings) },",
    "            { label: 'LLM cost (USD)', value: formatUsd(breakdown.totals.total_cost_usd) },",
    "          ]) +",
    "          '</div>' +",
    "          renderHarnessCard(breakdown.by_source_tool);",
    "      }",
    "      function renderReviewQueueView() {",
    "        const items = reviewItemsExpanded ? (getAggregate('review-items') || data.review_items) : data.review_items;",
    "        const stats = data.review_stats;",
    "        reviewQueueView.innerHTML = '<div class=\"kpi-grid\">' +",
    "          renderMetricCard('Review queue totals', [",
    "            { label: 'Entries', value: String(stats.total) },",
    "            { label: 'Kinds', value: String(stats.kinds) },",
    "            { label: 'Projects', value: String(stats.projects) },",
    "          ]) +",
    "          '</div>' +",
    "          renderReviewQueueCard(items) +",
    `          renderDrilldownButton('review-items', reviewItemsExpanded, stats.total, ${REVIEW_ITEMS_SHOWN});`,
    "        bindDrilldownButtons(reviewQueueView);",
    "      }",
    "      function renderSessionList(sessions) {",
    "        sessionList.innerHTML = '';",
    "        if (sessions.length === 0) {",
    "          const empty = document.createElement('p');",
    "          empty.className = 'empty';",
    "          empty.textContent = 'No sessions match the current filters.';",
    "          sessionList.append(empty);",
    "          return;",
    "        }",
    "        for (const session of sessions) {",
    "          const record = session.index;",
    "          const button = document.createElement('button');",
    "          button.type = 'button';",
    "          button.className = 'session-card' + (record.asd_session_id === selectedSessionId ? ' active' : '');",
    "          button.addEventListener('click', () => { selectedSessionId = record.asd_session_id; render(); });",
    "          button.innerHTML = '<h3>' + escapeHtml(record.topic) + '</h3>' +",
    "            '<div class=\"chips\">' +",
    "            '<span class=\"chip\">' + escapeHtml(record.source_tool) + '</span>' +",
    "            '<span class=\"chip\">' + escapeHtml(session.lifecycle_state) + '</span>' +",
    "            '<span class=\"chip\">' + escapeHtml(record.topic_source) + '</span>' +",
    "            renderQualityIssueChips(session.quality_issues) +",
    "            '</div>' +",
    "            '<p class=\"muted\">' + escapeHtml(record.asd_session_id) + '</p>' +",
    "            '<p>' + escapeHtml(record.next_step) + '</p>';",
    "          sessionList.append(button);",
    "        }",
    "      }",
    "      function renderDetail(session, detailData) {",
    "        if (!session) { detail.innerHTML = '<p class=\"empty\">No sessions available.</p>'; return; }",
    "        const record = session.index;",
    "        const summary = detailData ? detailData.summary : null;",
    "        const turns = detailData ? detailData.reduced_turns : [];",
    "        detail.innerHTML = '<h2>' + escapeHtml(record.topic) + '</h2>' +",
    "          '<div class=\"chips\">' +",
    "          '<span class=\"chip\">' + escapeHtml(record.asd_session_id) + '</span>' +",
    "          '<span class=\"chip\">' + escapeHtml(record.source_tool) + '</span>' +",
    "          '<span class=\"chip\">' + escapeHtml(session.lifecycle_state) + '</span>' +",
    "          '<span class=\"chip\">updated ' + escapeHtml(record.updated_at) + '</span>' +",
    "          renderQualityIssueChips(session.quality_issues) +",
    "          '</div>' +",
    "          '<div class=\"panel\"><h3>Summary</h3>' + (summary ? renderSummary(summary) : '<p class=\"empty\">Summary artifact missing.</p>') + '</div>' +",
    "          '<div class=\"panel\"><h3>Reduced timeline</h3>' + (turns.length === 0 ? '<p class=\"empty\">Reduced artifact missing or empty.</p>' : turns.map(renderTurn).join('')) + '</div>';",
    "      }",
    "      function renderQualityIssueChips(issues) {",
    "        if (!issues || issues.length === 0) return '';",
    "        return issues.map((issue) => '<span class=\"chip\">' + escapeHtml(issue) + '</span>').join('');",
    "      }",
    "      function renderSummary(summary) {",
    "        return '<p><strong>Topic source:</strong> ' + escapeHtml(summary.topic_source) + '</p>' +",
    "          '<p><strong>Next step:</strong> ' + escapeHtml(summary.next_step) + '</p>' +",
    "          '<p><strong>Deletion readiness:</strong> ' + escapeHtml(summary.deletion_readiness) + '</p>' +",
    "          renderList('What worked', summary.what_worked) +",
    "          renderList('What failed', summary.what_failed) +",
    "          renderList('Decisions', summary.what_was_decided) +",
    "          renderList('Useful commands', summary.useful_commands) +",
    "          renderList('Files of interest', summary.files_of_interest) +",
    "          renderList('Project learnings', summary.project_learnings) +",
    "          renderList('User learnings', summary.user_learnings);",
    "      }",
    "      function renderTurn(turn) {",
    "        return '<section class=\"turn\">' +",
    "          '<div class=\"chips\">' +",
    "          '<span class=\"chip\">turn ' + turn.index + '</span>' +",
    "          '<span class=\"chip\">verification ' + (turn.verification_seen ? 'yes' : 'no') + '</span>' +",
    "          '<span class=\"chip\">tool stubs ' + turn.tool_stub_count + '</span>' +",
    "          '</div>' +",
    "          '<p><strong>User prompt</strong></p><pre>' + escapeHtml(turn.user_prompt) + '</pre>' +",
    "          '<p><strong>Assistant summary</strong></p><pre>' + escapeHtml(turn.assistant_summary) + '</pre>' +",
    "          renderList('Files touched', turn.files_touched) + renderList('Commands seen', turn.commands_seen) +",
    "          '</section>';",
    "      }",
    "      function renderList(title, values) {",
    "        if (!values || values.length === 0) return '<p><strong>' + escapeHtml(title) + ':</strong> <span class=\"empty\">none</span></p>';",
    "        return '<div><p><strong>' + escapeHtml(title) + '</strong></p><ul>' + values.map((value) => '<li>' + escapeHtml(String(value)) + '</li>').join('') + '</ul></div>';",
    "      }",
    "      function renderMetricCard(title, entries) {",
    "        return '<section class=\"panel\"><h3>' + escapeHtml(title) + '</h3>' + renderMetricList(entries) + '</section>';",
    "      }",
    "      function renderMetricList(entries) {",
    "        if (!entries || entries.length === 0) return '<p class=\"empty\">No entries.</p>';",
    "        return '<ul class=\"metric-list\">' + entries.map((entry) => '<li><span>' + escapeHtml(entry.label) + '</span><strong>' + escapeHtml(entry.value) + '</strong></li>').join('') + '</ul>';",
    "      }",
    "      function metricEntries(values) {",
    "        return Object.entries(values).sort((left, right) => left[0].localeCompare(right[0])).map(([label, value]) => ({ label, value: String(value) }));",
    "      }",
    "      function renderKnowledgeCard(title, items) {",
    "        if (!items || items.length === 0) return '<section class=\"panel\"><h3>' + escapeHtml(title) + '</h3><p class=\"empty\">No entries.</p></section>';",
    "        return '<section class=\"panel\"><h3>' + escapeHtml(title) + '</h3><div class=\"stack\"><ul class=\"knowledge-list\">' + items.map((item) => '<li class=\"knowledge-item\"><strong>' + escapeHtml(item.title) + '</strong><div class=\"chips\">' + item.chips.map((chip) => '<span class=\"chip\">' + escapeHtml(chip) + '</span>').join('') + '</div><p>' + escapeHtml(item.body) + '</p>' + renderInlineLinks(item.links) + '</li>').join('') + '</ul></div></section>';",
    "      }",
    "      function renderHarnessCard(rows) {",
    '        if (!rows || rows.length === 0) return \'<section class="panel"><h3>Harness breakdown</h3><p class="empty">No harness data.</p></section>\';',
    "        return '<section class=\"panel\"><h3>Harness breakdown</h3><div class=\"stack\"><ul class=\"knowledge-list\">' + rows.map((row) => '<li class=\"knowledge-item\"><strong>' + escapeHtml(row.source_tool) + '</strong><div class=\"chips\">' + [row.sessions + ' sessions', row.project_learnings + ' project learnings', row.llm_rescued_topics + ' LLM topics', formatUsd(row.total_cost_usd)].map((chip) => '<span class=\"chip\">' + escapeHtml(chip) + '</span>').join('') + '</div><p>' + escapeHtml('Deterministic topics: ' + row.deterministic_topics + ' • Low-signal topics: ' + row.low_signal_topics + ' • Wrapper leaks: ' + row.wrapper_leak_topics + ' • User learnings: ' + row.user_learnings) + '</p>' + renderInlineLinks(['Cost per session mean: ' + formatUsd(row.cost_per_session_usd.mean), 'Telemetry calls: ' + row.telemetry_calls + ' (real ' + row.real_telemetry_calls + ', cache hits ' + row.cache_hits + ')', 'Unknown-cost calls: ' + row.unknown_cost_calls]) + '</li>').join('') + '</ul></div></section>';",
    "      }",
    "      function renderReviewQueueCard(items) {",
    '        if (!items || items.length === 0) return \'<section class="panel"><h3>Queued sessions</h3><p class="empty">No review queue entries.</p></section>\';',
    "        return '<section class=\"panel\"><h3>Queued sessions</h3><div class=\"stack\"><ul class=\"knowledge-list\">' + items.map((item) => '<li class=\"knowledge-item\"><strong>' + escapeHtml(item.session_id) + '</strong><div class=\"chips\">' + [item.review_kind, item.queue_state, item.current_lifecycle_state, item.project_key].map((chip) => '<span class=\"chip\">' + escapeHtml(chip) + '</span>').join('') + '</div><p>' + escapeHtml(item.reason) + '</p>' + renderInlineLinks(['Enqueued: ' + item.enqueued_at, 'Updated: ' + item.updated_at, 'CLI: marrow review show ' + item.session_id]) + '</li>').join('') + '</ul></div></section>';",
    "      }",
    "      function renderInlineLinks(values) {",
    "        if (!values || values.length === 0) return '<p class=\"empty\">No back-links.</p>';",
    "        return '<ul>' + values.map((value) => '<li>' + escapeHtml(String(value)) + '</li>').join('') + '</ul>';",
    "      }",
    "      function renderDrilldownButton(kind, expanded, total, shown) {",
    "        const lazyKey = kind === 'knowledge-projects' ? 'knowledge_projects' : kind === 'knowledge-instincts' ? 'knowledge_instincts' : 'review_items';",
    "        if (expanded || total <= shown || !data.lazy_aggregates[lazyKey]) return '';",
    "        return '<button type=\"button\" class=\"drilldown-btn\" data-drilldown=\"' + escapeHtml(kind) + '\">Show all ' + escapeHtml(String(total)) + '</button>';",
    "      }",
    "      function bindDrilldownButtons(container) {",
    "        for (const button of container.querySelectorAll('[data-drilldown]')) {",
    "          button.addEventListener('click', () => {",
    "            const kind = button.getAttribute('data-drilldown');",
    "            if (kind === 'knowledge-projects') knowledgeProjectsExpanded = true;",
    "            if (kind === 'knowledge-instincts') knowledgeInstinctsExpanded = true;",
    "            if (kind === 'review-items') reviewItemsExpanded = true;",
    "            if (kind === 'knowledge-projects' || kind === 'knowledge-instincts') renderKnowledgeView();",
    "            if (kind === 'review-items') renderReviewQueueView();",
    "          });",
    "        }",
    "      }",
    "      function formatUsd(value) { return '$' + Number(value ?? 0).toFixed(6); }",
    "      function formatBytes(value) {",
    "        if (value < 1024) return value + ' B';",
    "        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB';",
    "        if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MiB';",
    "        return (value / (1024 * 1024 * 1024)).toFixed(1) + ' GiB';",
    "      }",
    "      function hydrateSelect(select, label, values) {",
    "        select.innerHTML = '';",
    "        const empty = document.createElement('option');",
    "        empty.value = '';",
    "        empty.textContent = label;",
    "        select.append(empty);",
    "        for (const value of values) {",
    "          const option = document.createElement('option');",
    "          option.value = value;",
    "          option.textContent = value;",
    "          select.append(option);",
    "        }",
    "      }",
    "      function uniqueValues(values) { return [...new Set(values)].sort((left, right) => left.localeCompare(right)); }",
    "      function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll(\"\\\"\", '&quot;').replaceAll(\"'\", '&#39;'); }",
    "    </script>",
    "  </body>",
    "</html>",
  ].join("\n");
}
