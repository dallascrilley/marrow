import type { CommandContext } from "../cli.js";
import { createLedger } from "../db/ledger.js";
import {
  buildOperatorHealthModel,
  type OperatorHealthModel,
  type OperatorHealthStatus,
} from "../read/operator-health.js";

export type HealthCommandStatus = OperatorHealthStatus | "unverifiable";

type HealthOptions = {
  json: boolean;
};

export async function executeHealth(context: CommandContext): Promise<number> {
  const options = parseHealthOptions(context.args);

  try {
    const database = await createLedger();
    try {
      const report = await buildOperatorHealthModel(database);
      context.output.info(
        options.json ? JSON.stringify(report, null, 2) : formatOperatorHealth(report),
      );
      return healthExitCode(report.status);
    } finally {
      database.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.output.info(
      options.json
        ? JSON.stringify({ error: message, status: "unverifiable" }, null, 2)
        : ["System health: unverifiable", `Reason: ${message}`, "Next: marrow check"].join("\n"),
    );
    return healthExitCode("unverifiable");
  }
}

export function healthExitCode(status: HealthCommandStatus): number {
  switch (status) {
    case "healthy":
      return 0;
    case "degraded":
      return 1;
    case "unverifiable":
      return 2;
  }
}

export function formatOperatorHealth(report: OperatorHealthModel): string {
  const { events } = report.recall;
  const delivery =
    events.last_delivered_at === null
      ? "none recorded"
      : `${events.last_delivered_at} (${events.fires_delivered}/${events.total_fires} delivered)`;
  const countBudget = report.pipeline.gate.llm_budget;
  const usdBudget = report.pipeline.gate.usd_budget;

  return [
    `System health: ${report.status}`,
    `Last successful delivery: ${delivery}`,
    `Current blockers: ${report.reasons.length === 0 ? "none" : report.reasons.join(", ")}`,
    `Review freshness: ${report.review.freshness} (${report.review.reviewed.entry_count} reviewed)`,
    `LLM budget: ${countBudget.remaining} remaining of ${countBudget.max_per_window}; USD: $${usdBudget.remaining_usd.toFixed(2)} remaining of ${usdBudget.max_usd_per_window}`,
    `Storage pressure: ${report.storage.pressure} (${formatBytes(report.storage.inventory.total.bytes)} total; ${formatBytes(report.storage.reclaimable_bytes)} reclaimable)`,
    `Provider: ${formatProviderStatus(report)}`,
    `Next: ${report.recommendation.command}`,
  ].join("\n");
}

function parseHealthOptions(args: readonly string[]): HealthOptions {
  if (args.length === 0) {
    return { json: false };
  }
  if (args.length === 1 && args[0] === "--json") {
    return { json: true };
  }

  throw new Error(`Unknown health option: ${args.join(" ")}`);
}

function formatProviderStatus(report: OperatorHealthModel): string {
  if (report.provider === null) {
    return "not checked (optional; run `marrow doctor provider`)";
  }

  return report.provider.ok ? "ready" : `unavailable (${report.provider.summary})`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
