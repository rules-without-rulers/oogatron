import { runSync } from "../sync/run";
import { error, json } from "./respond";

// Bearer auth compared constant-time: hash both sides so length differences
// leak nothing, then timingSafeEqual on equal-size digests.
async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !env.ADMIN_TOKEN) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(match[1])),
    crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// Runs one budget-bounded sync slice inline and reports it; callers loop
// until done:true to drive a full backfill through Worker subrequest limits.
export async function handleBackfill(
  env: Env,
  request: Request,
): Promise<Response> {
  if (!(await authorized(request, env))) {
    return error(401, "unauthorized");
  }
  const result = await runSync(env, "admin");
  return json({ result: { ...result } });
}
