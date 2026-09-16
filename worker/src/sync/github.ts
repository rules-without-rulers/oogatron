import { Budget } from "./budget";

export class RateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimited";
  }
}

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ type?: string; message: string }>;
}

export interface GqlResult {
  data: Record<string, unknown>;
  rateRemaining: number;
}

export async function githubGraphQL(
  env: Env,
  budget: Budget,
  query: string,
  variables: Record<string, unknown>,
): Promise<GqlResult> {
  let attempt = 0;
  for (;;) {
    budget.spend();
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
        "user-agent": "oogatron",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel();
      throw new RateLimited(`GitHub rate limit response: ${res.status}`);
    }
    if ((res.status === 502 || res.status === 503) && attempt === 0) {
      await res.body?.cancel();
      attempt++;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`GitHub GraphQL HTTP ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as GraphQLResponse;
    if (body.errors?.length) {
      if (body.errors.some((e) => e.type === "RATE_LIMITED")) {
        throw new RateLimited(body.errors[0].message);
      }
      throw new Error(`GitHub GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    if (!body.data) throw new Error("GitHub GraphQL: empty data");

    const rl = body.data["rateLimit"] as { remaining: number } | undefined;
    return { data: body.data, rateRemaining: rl?.remaining ?? Infinity };
  }
}
