// Known Node/libuv/POSIX errno codes. An allowlist (not a denylist) so that
// ordinary all-caps E-words in failure text — EXPECTED, EXAMPLE, EXTERNAL,
// ENABLED, EXPORTS — are never mistaken for an errno signature.
const KNOWN_ERRNO_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAGAIN",
  "EBADF",
  "EBUSY",
  "ECANCELED",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EFAULT",
  "EFBIG",
  "EHOSTUNREACH",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMLINK",
  "ENAMETOOLONG",
  "ENETDOWN",
  "ENETUNREACH",
  "ENFILE",
  "ENOBUFS",
  "ENODEV",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOSYS",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTFOUND",
  "ENOTSOCK",
  "ENOTSUP",
  "ENXIO",
  "EOPNOTSUPP",
  "EOVERFLOW",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "EPROTONOSUPPORT",
  "EPROTOTYPE",
  "ERANGE",
  "EROFS",
  "ESHUTDOWN",
  "ESPIPE",
  "ESRCH",
  "ETIMEDOUT",
  "EXDEV",
]);

// Tier-3b: normalize a failure summary to a canonical symptom signature so the
// same error keys to the same trigger — and thus the same durable Instinct id —
// across sessions. Returns null when no recognizable signature is present.
export function normalizeErrorSignature(text: string): string | null {
  for (const match of text.matchAll(/\b(E[A-Z]{2,})\b/g)) {
    const code = match[1];
    if (code !== undefined && KNOWN_ERRNO_CODES.has(code)) {
      return code;
    }
  }
  const exception = text.match(/\b([A-Z][A-Za-z0-9]*(?:Error|Exception))\b/)?.[1];
  if (exception !== undefined) {
    return exception;
  }
  const exitCode = text.match(/\bexit(?:ed with)?(?:\s+status)?\s+code\s+(\d+)\b/i)?.[1];
  if (exitCode !== undefined) {
    return `exit code ${exitCode}`;
  }
  return null;
}

export function errorSignatureTrigger(summary: string, scopeKey: string): string | undefined {
  const signature = normalizeErrorSignature(summary);
  return signature === null ? undefined : `When ${signature} recurs in ${scopeKey}.`;
}
