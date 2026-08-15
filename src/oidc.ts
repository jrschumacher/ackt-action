/**
 * Mints the GitHub Actions OIDC token the ackt service uses to identify the
 * repository a request is really coming from.
 *
 * The service can't trust a `repo` query parameter — anyone can type one. It
 * trusts this token's signed claims instead (`repository`, `repository_id`,
 * `repository_visibility`), which only the runner can produce and only for
 * the repository the workflow is actually running in.
 *
 * The runner exposes the minting endpoint through two environment variables,
 * and **only when the workflow granted `id-token: write`** — with one
 * exception that is not the consumer's fault and must not be reported as if
 * it were: a `pull_request` event **from a fork** never gets those variables,
 * whatever `permissions:` the workflow declares. See `FORK_DEGRADED_MESSAGE`
 * and `oidcEndpointPresent`. Outside that case their absence is not a
 * degraded mode to route around — see `mintOidcToken` — it is a missing line
 * in the consumer's workflow file, and the only useful thing to do about it
 * is say so.
 *
 * I/O lives here rather than in query.ts so that module stays a pure URL
 * builder and parser; the minted token is threaded into `queryAckt` as an
 * argument.
 */

/**
 * Must match the service's `AUDIENCE` (service/src/oidc.ts) exactly. The
 * service rejects a token minted for any other audience, which is what stops
 * a token issued for some unrelated service from being replayed at ackt.
 */
export const OIDC_AUDIENCE = "ackt.dev";

/**
 * Structural subset of `fetch` — the same trick query.ts uses, so tests pass
 * a plain object literal instead of constructing a real `Response`. Declared
 * here rather than imported from query.ts because these two modules call
 * different services and shouldn't be coupled through a shared alias.
 */
export type TokenFetchLike = (
  url: string,
  init: { readonly headers: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}>;

/**
 * `ACTIONS_ID_TOKEN_REQUEST_URL` already carries a query string (`?api-version=…`),
 * so the audience is appended with `&`, never `?`.
 */
export function buildTokenRequestUrl(requestUrl: string, audience: string = OIDC_AUDIENCE): string {
  return `${requestUrl}&audience=${encodeURIComponent(audience)}`;
}

/**
 * The permission this needs, and where it goes. Kept as one line so it
 * survives being wrapped in a `::error::` workflow annotation.
 */
function missingPermissionMessage(workflowRef: string | undefined): string {
  const workflow = workflowFileFromRef(workflowRef);
  return (
    `ackt requires a GitHub Actions OIDC token and the runner did not expose one. ` +
    `Add 'permissions: id-token: write' to ${workflow} — alongside the contents/statuses/pull-requests/issues permissions ackt already needs — ` +
    `and re-run. Without it the ackt service cannot verify which repository this run belongs to, ` +
    `so it will not record the check and the dashboard will stay empty.`
  );
}

/**
 * Whether the runner exposed the OIDC minting endpoint at all. Both variables
 * or neither — GitHub sets them together.
 *
 * Split out of `mintOidcToken` because the *same* absence means two opposite
 * things, and only the caller knows which: on a same-repository run it means
 * the workflow is missing `id-token: write` and should fail loudly; on a
 * fork-origin `pull_request` it means GitHub withheld the token by policy and
 * nothing the maintainer can write in the workflow file will change that.
 * See index.ts, which pairs this with `isForkPullRequest`.
 */
export function oidcEndpointPresent(env: Record<string, string | undefined>): boolean {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  return requestUrl !== undefined && requestUrl.length > 0 && requestToken !== undefined && requestToken.length > 0;
}

/**
 * What ackt says when it degrades on a fork pull request, instead of failing
 * with advice the reader cannot act on.
 *
 * Three things it has to do, and the previous message did none of them: name
 * the real cause (the fork, not a permission), state exactly what is lost
 * (recording and ancestry — not the attestation check itself, which still
 * works for a public repository), and say plainly that there is nothing to
 * fix. ackt's adoption story is public repositories taking outside
 * contributions, so this path is the common case, not an edge; a run that
 * goes red here breaks the promise `fail-on-unattested: false` makes.
 *
 * One line, because a `::warning::` annotation is truncated at the first
 * newline.
 */
export const FORK_DEGRADED_MESSAGE =
  "ackt is running on a pull request from a fork, where GitHub does not issue an Actions OIDC token no matter what permissions the workflow grants. " +
  "Continuing in a reduced mode: the attestation check still runs if this repository is public, but this run is not recorded and commit ancestry is not reported. " +
  "This is not a misconfiguration — there is nothing to add to the workflow file.";

/**
 * `GITHUB_WORKFLOW_REF` looks like
 * `owner/repo/.github/workflows/ackt.yml@refs/heads/main`. Naming the actual
 * file beats telling someone to go find "their workflow".
 */
export function workflowFileFromRef(workflowRef: string | undefined): string {
  if (workflowRef === undefined || workflowRef.length === 0) {
    return "your workflow file (e.g. .github/workflows/ackt.yml)";
  }
  const withoutRef = workflowRef.split("@")[0] ?? workflowRef;
  const marker = withoutRef.indexOf(".github/workflows/");
  return marker === -1 ? withoutRef : withoutRef.slice(marker);
}

/**
 * Returns the raw JWT.
 *
 * Throws — never returns a sentinel, and never falls back to an
 * unauthenticated request — when the runner exposed no minting endpoint. A
 * silent degrade here is the worst available outcome: the run would still go
 * green, the service would still answer the public-repo query, and the only
 * symptom would be a dashboard that never populates, with nothing in the log
 * to explain why.
 *
 * The fork case is the one absence that is **not** this: it is handled by the
 * caller, which never calls this function there (index.ts, `oidcEndpointPresent`
 * + `isForkPullRequest`). Reaching the throw below therefore still means what
 * the message says it means.
 */
export async function mintOidcToken(env: Record<string, string | undefined>, fetchImpl: TokenFetchLike, audience: string = OIDC_AUDIENCE): Promise<string> {
  if (!oidcEndpointPresent(env)) {
    throw new Error(missingPermissionMessage(env.GITHUB_WORKFLOW_REF));
  }
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "";

  const response = await fetchImpl(buildTokenRequestUrl(requestUrl, audience), { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ""}`, Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`ackt could not mint a GitHub Actions OIDC token: ${response.status} ${response.statusText}`);
  }
  return parseTokenResponse(await response.json());
}

/** The minting endpoint answers `{"value": "<jwt>"}`. Anything else is a bug worth failing on, not a token worth sending. */
export function parseTokenResponse(data: unknown): string {
  if (typeof data !== "object" || data === null) {
    throw new Error("malformed OIDC token response: expected an object");
  }
  const value = (data as Record<string, unknown>).value;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("malformed OIDC token response: 'value' must be a non-empty string");
  }
  return value;
}
