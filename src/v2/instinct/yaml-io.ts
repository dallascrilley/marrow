import {
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  type Delta,
  deltaSchema,
  type Instinct,
  instinctSchema,
  type SessionBundle,
  sessionBundleSchema,
} from "./schema.js";

/** Strict YAML scalar emitter: always single-quoted, with `''` escape. */
export function yamlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function yamlNullableString(value: string | null): string {
  return value === null ? "null" : yamlString(value);
}

function yamlNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : ""))
    .join("\n");
}

export function serializeInstinct(instinct: Instinct): string {
  const lines: string[] = [
    `schema_version: ${instinct.schema_version}`,
    `id: ${yamlString(instinct.id)}`,
    "trigger: |",
    indentBlock(instinct.trigger.trimEnd(), 2),
    "finding: |",
    indentBlock(instinct.finding.trimEnd(), 2),
    `confidence: ${yamlNumber(instinct.confidence)}`,
    `domain: ${yamlString(instinct.domain)}`,
    `maturity: ${yamlString(instinct.maturity)}`,
    `scope: ${yamlString(instinct.scope)}`,
    `project_id: ${yamlString(instinct.project_id)}`,
    "source:",
    `  first_session: ${yamlString(instinct.source.first_session)}`,
    `  first_observed_at: ${yamlString(instinct.source.first_observed_at)}`,
    "  source_refs:",
  ];

  for (const ref of instinct.source.source_refs) {
    lines.push(`    - kind: ${yamlString(ref.kind)}`);
    lines.push(`      path: ${yamlString(ref.path)}`);
    lines.push(`      session: ${yamlString(ref.session)}`);
  }

  lines.push("  observations:");
  for (const observation of instinct.source.observations) {
    lines.push(`    - session: ${yamlString(observation.session)}`);
    lines.push(`      reinforcing: ${observation.reinforcing ? "true" : "false"}`);
    lines.push(`      at: ${yamlString(observation.at)}`);
    if (observation.correction !== undefined) {
      lines.push(`      correction: ${yamlString(observation.correction)}`);
    }
  }

  if (instinct.related.length === 0) {
    lines.push("related: []");
  } else {
    lines.push("related:");
    for (const related of instinct.related) {
      lines.push(`  - ${yamlString(related)}`);
    }
  }

  lines.push(`created_at: ${yamlString(instinct.created_at)}`);
  lines.push(`updated_at: ${yamlString(instinct.updated_at)}`);
  lines.push(`last_promoted_at: ${yamlNullableString(instinct.last_promoted_at)}`);

  return `${lines.join("\n")}\n`;
}

function serializeDelta(delta: Delta): string[] {
  switch (delta.op) {
    case "create":
      return [
        `  - op: create`,
        `    instinct_id: ${yamlString(delta.instinct_id)}`,
        `    trigger: ${yamlString(delta.trigger)}`,
        `    finding: ${yamlString(delta.finding)}`,
        `    domain: ${yamlString(delta.domain)}`,
        `    initial_confidence: ${yamlNumber(delta.initial_confidence)}`,
      ];
    case "reinforce":
      return [
        `  - op: reinforce`,
        `    instinct_id: ${yamlString(delta.instinct_id)}`,
        `    delta:`,
        `      confidence: ${yamlNumber(delta.delta.confidence)}`,
      ];
    case "correct":
      return [
        `  - op: correct`,
        `    instinct_id: ${yamlString(delta.instinct_id)}`,
        `    correction: ${yamlString(delta.correction)}`,
        `    delta:`,
        `      confidence: ${yamlNumber(delta.delta.confidence)}`,
      ];
    case "deprecate":
      return [
        `  - op: deprecate`,
        `    instinct_id: ${yamlString(delta.instinct_id)}`,
        `    reason: ${yamlString(delta.reason)}`,
      ];
    case "merge":
      return [
        `  - op: merge`,
        `    instinct_id: ${yamlString(delta.instinct_id)}`,
        `    into: ${yamlString(delta.into)}`,
      ];
    case "revive":
      return [
        `  - op: revive`,
        `    instinct_id: ${yamlString(delta.instinct_id)}`,
        `    reason: ${yamlString(delta.reason)}`,
      ];
    default: {
      const _exhaustive: never = delta;
      return [`  - op: ${yamlString(String(_exhaustive))}`];
    }
  }
}

export function serializeSessionBundle(bundle: SessionBundle): string {
  const lines: string[] = [
    `schema_version: ${bundle.schema_version}`,
    `session_id: ${yamlString(bundle.session_id)}`,
    `project_id: ${yamlString(bundle.project_id)}`,
    `source_adapter: ${yamlString(bundle.source_adapter)}`,
    `source_transcript: ${yamlString(bundle.source_transcript)}`,
    `ingested_at: ${yamlString(bundle.ingested_at)}`,
    `reviewed_at: ${yamlNullableString(bundle.reviewed_at)}`,
    `reviewer: ${yamlNullableString(bundle.reviewer)}`,
    "diary: |",
    indentBlock(bundle.diary.trimEnd(), 2),
    "deltas:",
  ];

  for (const delta of bundle.deltas) {
    lines.push(...serializeDelta(delta));
  }
  if (bundle.deltas.length === 0) {
    lines.push("  []");
  }

  if (bundle.extraction_cost) {
    lines.push("extraction_cost:");
    lines.push(`  model: ${yamlString(bundle.extraction_cost.model)}`);
    lines.push(`  input_tokens: ${bundle.extraction_cost.input_tokens}`);
    lines.push(`  output_tokens: ${bundle.extraction_cost.output_tokens}`);
    lines.push(`  usd: ${yamlNumber(bundle.extraction_cost.usd)}`);
  } else {
    lines.push("extraction_cost: null");
  }

  return `${lines.join("\n")}\n`;
}

function parseQuotedScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "null") return "";
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  return trimmed;
}

function parseScalarValue(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("'")) return parseQuotedScalar(trimmed);
  return trimmed;
}

type YamlNode = Record<string, unknown>;

type YamlStackFrame = {
  indent: number;
  container: YamlNode | unknown[];
  /** Set when `key:` has no value yet; next line decides map vs sequence. */
  pendingListKey?: string;
};

function parseSimpleYaml(content: string): YamlNode {
  const root: YamlNode = {};
  const stack: YamlStackFrame[] = [{ indent: -1, container: root }];
  let blockKey: string | null = null;
  let blockLines: string[] = [];

  const flushBlock = (): void => {
    if (blockKey === null) return;
    const text = blockLines.join("\n").trimEnd();
    const parent = stack[stack.length - 1]?.container as YamlNode;
    parent[blockKey] = text;
    blockKey = null;
    blockLines = [];
  };

  const lines = content.split(/\r?\n/u);
  for (const line of lines) {
    if (blockKey !== null) {
      if (/^ {2}\S/u.test(line) || line.trim().length === 0) {
        blockLines.push(line.replace(/^ {2}/u, ""));
        continue;
      }
      flushBlock();
    }

    if (line.trim().length === 0) continue;

    const indent = line.search(/\S/u);
    const trimmed = line.trim();

    while (stack.length > 1) {
      const top = stack.at(-1);
      if (top === undefined || indent > top.indent) {
        break;
      }
      stack.pop();
    }

    if (trimmed.startsWith("- ")) {
      const frame = stack.at(-1);
      if (!frame) {
        throw new Error("Expected stack frame");
      }
      let list: unknown[];
      if (Array.isArray(frame.container)) {
        list = frame.container;
      } else if (frame.pendingListKey !== undefined) {
        const parentNode = frame.container as YamlNode;
        list = [];
        parentNode[frame.pendingListKey] = list;
        stack[stack.length - 1] = { indent: frame.indent, container: list };
      } else {
        throw new Error("Expected list parent");
      }
      const itemText = trimmed.slice(2).trim();
      if (itemText.includes(":")) {
        const [key, ...rest] = itemText.split(":");
        const itemKey = key?.trim();
        if (!itemKey) {
          continue;
        }
        const item: YamlNode = { [itemKey]: parseScalarValue(rest.join(":")) };
        list.push(item);
        stack.push({ indent, container: item });
      } else {
        list.push(parseScalarValue(itemText));
      }
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const rest = trimmed.slice(colonIndex + 1).trim();

    if (rest === "|") {
      blockKey = key;
      blockLines = [];
      const parent = stack[stack.length - 1]?.container as YamlNode;
      parent[key] = "";
      continue;
    }

    const frame = stack.at(-1);
    if (!frame) {
      throw new Error("Expected stack frame");
    }
    let parent: YamlNode;
    if (Array.isArray(frame.container)) {
      throw new Error("Cannot add key inside a YAML list");
    }
    if (frame.pendingListKey !== undefined) {
      const parentNode = frame.container as YamlNode;
      const child: YamlNode = {};
      parentNode[frame.pendingListKey] = child;
      stack[stack.length - 1] = { indent: frame.indent, container: child };
      parent = child;
    } else {
      parent = frame.container as YamlNode;
    }

    if (rest.length === 0) {
      parent[key] = null;
      stack.push({ indent, container: parent, pendingListKey: key });
    } else if (rest === "[]") {
      parent[key] = [];
    } else {
      parent[key] = parseScalarValue(rest);
    }
  }

  flushBlock();
  return root;
}

function nodeToInstinct(node: YamlNode): Instinct {
  const source = node.source as YamlNode;
  const observations = (source.observations as YamlNode[] | undefined) ?? [];
  const sourceRefs = (source.source_refs as YamlNode[] | undefined) ?? [];
  const relatedRaw = node.related;
  const related = Array.isArray(relatedRaw) ? relatedRaw.map(String) : [];

  return instinctSchema.parse({
    schema_version: node.schema_version,
    id: node.id,
    trigger: node.trigger,
    finding: node.finding,
    confidence: clampConfidence(Number(node.confidence)),
    domain: node.domain,
    maturity: node.maturity,
    scope: node.scope,
    project_id: node.project_id ?? "",
    source: {
      first_session: source.first_session,
      first_observed_at: source.first_observed_at,
      source_refs: sourceRefs.map((ref) => ({
        kind: ref.kind,
        path: ref.path,
        session: ref.session,
      })),
      observations: observations.map((obs) => ({
        session: obs.session,
        reinforcing: obs.reinforcing === true || obs.reinforcing === "true",
        at: obs.at,
        correction:
          obs.correction === undefined || obs.correction === null
            ? undefined
            : String(obs.correction),
      })),
    },
    related,
    created_at: node.created_at,
    updated_at: node.updated_at,
    last_promoted_at:
      node.last_promoted_at === null || node.last_promoted_at === "null"
        ? null
        : node.last_promoted_at,
  });
}

function nodeToDelta(item: YamlNode): Delta {
  const op = item.op;
  switch (op) {
    case "create":
      return deltaSchema.parse({
        op: "create",
        instinct_id: item.instinct_id,
        trigger: item.trigger,
        finding: item.finding,
        domain: item.domain,
        initial_confidence: Number(item.initial_confidence),
      });
    case "reinforce": {
      const deltaNode = item.delta as YamlNode;
      return deltaSchema.parse({
        op: "reinforce",
        instinct_id: item.instinct_id,
        delta: { confidence: Number(deltaNode.confidence) },
      });
    }
    case "correct": {
      const deltaNode = item.delta as YamlNode;
      return deltaSchema.parse({
        op: "correct",
        instinct_id: item.instinct_id,
        correction: item.correction,
        delta: { confidence: Number(deltaNode.confidence) },
      });
    }
    case "deprecate":
      return deltaSchema.parse({
        op: "deprecate",
        instinct_id: item.instinct_id,
        reason: item.reason,
      });
    case "merge":
      return deltaSchema.parse({
        op: "merge",
        instinct_id: item.instinct_id,
        into: item.into,
      });
    case "revive":
      return deltaSchema.parse({
        op: "revive",
        instinct_id: item.instinct_id,
        reason: item.reason,
      });
    default:
      throw new Error(`Unknown delta op: ${String(op)}`);
  }
}

function nodeToSessionBundle(node: YamlNode): SessionBundle {
  const deltasRaw = node.deltas;
  const deltas = Array.isArray(deltasRaw)
    ? deltasRaw.map((entry) => nodeToDelta(entry as YamlNode))
    : [];

  const costNode = node.extraction_cost;
  const extraction_cost =
    costNode === null || costNode === "null" || costNode === undefined
      ? null
      : {
          model: String((costNode as YamlNode).model),
          input_tokens: Number((costNode as YamlNode).input_tokens),
          output_tokens: Number((costNode as YamlNode).output_tokens),
          usd: Number((costNode as YamlNode).usd),
        };

  return sessionBundleSchema.parse({
    schema_version: node.schema_version,
    session_id: node.session_id,
    project_id: node.project_id,
    source_adapter: node.source_adapter,
    source_transcript: node.source_transcript,
    ingested_at: node.ingested_at,
    reviewed_at: node.reviewed_at === null || node.reviewed_at === "null" ? null : node.reviewed_at,
    reviewer: node.reviewer === null || node.reviewer === "null" ? null : node.reviewer,
    diary: node.diary,
    deltas,
    extraction_cost,
  });
}

export function parseInstinctYaml(content: string): Instinct {
  return nodeToInstinct(parseSimpleYaml(content));
}

export function parseSessionBundleYaml(content: string): SessionBundle {
  return nodeToSessionBundle(parseSimpleYaml(content));
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return CONFIDENCE_MIN;
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
}
