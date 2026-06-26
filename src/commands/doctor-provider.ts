import type { CommandContext } from "../cli.js";
import {
  assessProviderPreflight,
  providerPreflightExitCode,
} from "../pipeline/provider-preflight.js";

export async function executeDoctorProvider(context: CommandContext): Promise<number> {
  const options = parseDoctorProviderOptions(context.args);
  const report = await assessProviderPreflight({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.maxPer === undefined ? {} : { maxPer: options.maxPer }),
    ...(options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  if (options.json) {
    context.output.info(JSON.stringify(report, null, 2));
  } else {
    context.output.info(report.summary);
  }

  return providerPreflightExitCode(report);
}

function parseDoctorProviderOptions(args: readonly string[]): {
  apiKey?: string;
  json: boolean;
  maxPer?: string;
  maxUsd?: string;
  model?: string;
} {
  let json = false;
  let apiKey: string | undefined;
  let maxPer: string | undefined;
  let maxUsd: string | undefined;
  let model: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--max-per") {
      maxPer = requireOptionValue("--max-per", args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--max-usd") {
      maxUsd = requireOptionValue("--max-usd", args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--model") {
      model = requireOptionValue("--model", args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--api-key") {
      apiKey = requireOptionValue("--api-key", args[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown doctor provider option: ${arg}`);
  }

  return {
    json,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(maxPer === undefined ? {} : { maxPer }),
    ...(maxUsd === undefined ? {} : { maxUsd }),
    ...(model === undefined ? {} : { model }),
  };
}

function requireOptionValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}
