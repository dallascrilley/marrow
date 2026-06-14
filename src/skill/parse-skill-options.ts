export type SkillCommandOptions = {
  skillId: string;
  json: boolean;
  limit: number;
  skillRoots: string[];
};

export function parseSkillCommandOptions(
  args: readonly string[],
  subcommand: string,
): SkillCommandOptions {
  let json = false;
  let limit = 20;
  const skillRoots: string[] = [];
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--skill-root") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--skill-root requires a directory path");
      }
      skillRoots.push(value);
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--limit requires a value");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length !== 1) {
    throw new Error(`skill ${subcommand} requires exactly one skill id argument`);
  }

  const skillId = positional[0];
  if (!skillId) {
    throw new Error(`skill ${subcommand} requires exactly one skill id argument`);
  }

  return {
    skillId,
    json,
    limit,
    skillRoots,
  };
}
