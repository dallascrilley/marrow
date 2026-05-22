import { createHash } from "node:crypto";

import { slugFromFinding } from "./schema.js";

export function instinctIdFromTriggerFinding(
  trigger: string,
  finding: string,
): string {
  const slug = slugFromFinding(finding || trigger);
  const hash = createHash("sha256")
    .update(`${trigger}|${finding}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  const base = slug.length > 0 ? slug : "instinct";
  const id = `${base}-${hash}`;
  return id.length <= 80 ? id : `${id.slice(0, 72)}-${hash}`;
}
