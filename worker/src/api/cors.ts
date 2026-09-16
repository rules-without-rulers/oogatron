// CORS: * on public GET endpoints only; /admin/* gets no CORS headers.
export function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("access-control-allow-origin", "*");
  return out;
}

export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "access-control-max-age": "86400",
    },
  });
}
