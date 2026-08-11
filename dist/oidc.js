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
 * and **only when the workflow granted `id-token: write`**. Their absence is
 * not a degraded mode to route around — see `mintOidcToken` — it is a missing
 * line in the consumer's workflow file, and the only useful thing to do about
 * it is say so.
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
 * `ACTIONS_ID_TOKEN_REQUEST_URL` already carries a query string (`?api-version=…`),
 * so the audience is appended with `&`, never `?`.
 */
export function buildTokenRequestUrl(requestUrl, audience = OIDC_AUDIENCE) {
    return `${requestUrl}&audience=${encodeURIComponent(audience)}`;
}
/**
 * The permission this needs, and where it goes. Kept as one line so it
 * survives being wrapped in a `::error::` workflow annotation.
 */
function missingPermissionMessage(workflowRef) {
    const workflow = workflowFileFromRef(workflowRef);
    return (`ackt requires a GitHub Actions OIDC token and the runner did not expose one. ` +
        `Add 'permissions: id-token: write' to ${workflow} — alongside the contents/statuses/pull-requests/issues permissions ackt already needs — ` +
        `and re-run. Without it the ackt service cannot verify which repository this run belongs to, ` +
        `so it will not record the check and the dashboard will stay empty.`);
}
/**
 * `GITHUB_WORKFLOW_REF` looks like
 * `owner/repo/.github/workflows/ackt.yml@refs/heads/main`. Naming the actual
 * file beats telling someone to go find "their workflow".
 */
export function workflowFileFromRef(workflowRef) {
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
 */
export async function mintOidcToken(env, fetchImpl, audience = OIDC_AUDIENCE) {
    const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (requestUrl === undefined || requestUrl.length === 0 || requestToken === undefined || requestToken.length === 0) {
        throw new Error(missingPermissionMessage(env.GITHUB_WORKFLOW_REF));
    }
    const response = await fetchImpl(buildTokenRequestUrl(requestUrl, audience), { headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" } });
    if (!response.ok) {
        throw new Error(`ackt could not mint a GitHub Actions OIDC token: ${response.status} ${response.statusText}`);
    }
    return parseTokenResponse(await response.json());
}
/** The minting endpoint answers `{"value": "<jwt>"}`. Anything else is a bug worth failing on, not a token worth sending. */
export function parseTokenResponse(data) {
    if (typeof data !== "object" || data === null) {
        throw new Error("malformed OIDC token response: expected an object");
    }
    const value = data.value;
    if (typeof value !== "string" || value.length === 0) {
        throw new Error("malformed OIDC token response: 'value' must be a non-empty string");
    }
    return value;
}
