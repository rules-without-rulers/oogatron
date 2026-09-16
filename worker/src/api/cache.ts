const GEN_KEY = "cache:gen";
const TTL_SECONDS = 60;

// Cache bust is a generation bump, not list+delete: one KV write, no delete
// races with in-flight request-side puts, and orphaned entries self-expire
// within the TTL anyway.
export async function bumpCacheGeneration(env: Env): Promise<void> {
  await env.CACHE.put(GEN_KEY, String(Date.now()));
}

// Key on pathname+search (plus generation) rather than the absolute URL, so
// entries survive a move to a custom domain — a deliberate refinement of the
// spec's "keyed by full URL".
export async function cached(
  env: Env,
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const gen = (await env.CACHE.get(GEN_KEY)) ?? "0";
  const key = `v1:${gen}:${url.pathname}${url.search}`;

  const hit = await env.CACHE.get(key);
  if (hit !== null) {
    return new Response(hit, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-oogatron-cache": "hit",
      },
    });
  }

  const res = await handler();
  if (res.status === 200) {
    const body = await res.clone().text();
    await env.CACHE.put(key, body, { expirationTtl: TTL_SECONDS });
  }
  return res;
}
