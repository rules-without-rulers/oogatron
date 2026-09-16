export type EventType =
  | "commit"
  | "pr"
  | "review"
  | "comment_issue"
  | "comment_review"
  | "comment_commit";

// A reference to whoever performed an event, as GraphQL reports it. Identity
// resolution (identity.ts) turns this into a contributors row.
export interface ActorRef {
  githubId: number | null;
  login: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  typename: string | null; // "User" | "Bot" | "Mannequin" | "Organization"
  email: string | null; // commit author email when there is no linked user
}

export interface ParsedEvent {
  type: EventType;
  externalId: string;
  occurredAt: string;
  actor: ActorRef;
  payload: Record<string, unknown>;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

// GraphQL actor shapes as they appear in responses.
export interface GqlActor {
  login: string;
  avatarUrl?: string;
  __typename?: string;
  databaseId?: number | null;
}

export function actorFrom(a: GqlActor | null | undefined): ActorRef {
  if (!a) {
    return {
      githubId: null,
      login: null,
      displayName: null,
      avatarUrl: null,
      typename: null,
      email: null,
    };
  }
  return {
    githubId: a.databaseId ?? null,
    login: a.login,
    displayName: null,
    avatarUrl: a.avatarUrl ?? null,
    typename: a.__typename ?? null,
    email: null,
  };
}
