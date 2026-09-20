import { OWNER, SCHEMA_VERSION } from "../config";

// Every JSON response carries the same meta block; generated_at is
// response-assembly time (a snapshot preserves the moment it was taken —
// last-sync time is visible in /v1/health instead).
export function json(
  body: Record<string, unknown>,
  init?: ResponseInit,
): Response {
  const withMeta = {
    meta: {
      generated_at: new Date().toISOString(),
      org: OWNER,
      schema_version: SCHEMA_VERSION,
    },
    ...body,
  };
  return new Response(JSON.stringify(withMeta), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}
