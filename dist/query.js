/**
 * Pure URL construction and response parsing for `GET /api/v1/ackt` and
 * `POST /api/v1/ancestry` (docs/superpowers/specs/2026-08-11-dashboard-design.md,
 * "Two-phase: git answers the question git can answer"). The one impure
 * piece — calling `fetch` — is a thin wrapper that takes the fetch
 * implementation as a parameter, so tests supply a fake and never touch the
 * network. `git` itself is deliberately not touched here — see
 * `ancestry.ts`'s header comment for why that module owns `execFileSync`
 * and this one stays a pure URL/body builder plus response parser.
 */
export function buildAcktQueryUrl(input) {
    const url = new URL("/api/v1/ackt", input.service);
    url.searchParams.set("repo", input.repo);
    url.searchParams.set("pr", String(input.pr));
    url.searchParams.set("actor", input.actor);
    url.searchParams.set("head", input.head);
    return url.toString();
}
function parseAttestedHeads(record) {
    const raw = record.attested_heads;
    if (!Array.isArray(raw))
        return [];
    return raw.filter((h) => typeof h === "string");
}
/**
 * Throws on anything that isn't the documented `{attested: boolean}` shape.
 * A malformed response should fail the run loudly, not silently read as
 * "not attested" — that would be a fail-open on a service outage or a
 * breaking API change, exactly backwards for a security control.
 *
 * `attested_heads` is deliberately not held to the same standard — see
 * `AcktQueryResult`'s doc comment — so a missing or malformed key there
 * degrades to `[]` instead of failing the whole query.
 */
export function parseAcktResponse(data) {
    if (typeof data !== "object" || data === null) {
        throw new Error("malformed ackt response: expected an object");
    }
    const record = data;
    if (typeof record.attested !== "boolean") {
        throw new Error("malformed ackt response: 'attested' must be a boolean");
    }
    const statementSha256 = typeof record.statement_sha256 === "string" ? record.statement_sha256 : null;
    return { attested: record.attested, statementSha256, attestedHeads: parseAttestedHeads(record) };
}
/**
 * `token` is the GitHub Actions OIDC token from oidc.ts, sent as
 * `Authorization: Bearer`. It's a parameter rather than something this module
 * mints because minting is I/O and this module is otherwise pure — see
 * oidc.ts's header comment.
 *
 * The service reads its signed claims to learn which repository this run
 * really belongs to, which is what lets it answer for private repositories
 * and record the check for the dashboard. A query without it is answered for
 * public repositories only, and recorded nowhere.
 */
export async function queryAckt(input, fetchImpl, token) {
    const url = buildAcktQueryUrl(input);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!response.ok) {
        throw new Error(`ackt query failed: ${response.status} ${response.statusText}`);
    }
    return parseAcktResponse(await response.json());
}
export function buildAncestryPostUrl(service) {
    return new URL("/api/v1/ancestry", service).toString();
}
/**
 * `token` is the same GitHub Actions OIDC token `queryAckt` used — minted
 * once per run (index.ts), never twice. The service requires it here too,
 * and more strictly: writing a verdict into a repository's audit trail has
 * no public-repo or session fallback the way reading does (service's
 * `attest.ts`, `handlePostAncestry`'s doc comment) — an unverified request
 * is refused outright, not merely unrecorded.
 *
 * Callers should treat a rejection from this function as non-fatal — see
 * index.ts, which never lets an ancestry-reporting failure turn an
 * otherwise-successful attestation run red. That policy lives at the call
 * site, not here, so this function stays a straightforward "throw on
 * anything other than success," same as `queryAckt`.
 */
export async function postAncestry(input, fetchImpl, token) {
    const url = buildAncestryPostUrl(input.service);
    const body = JSON.stringify({
        repo: input.repo,
        pr: input.pr,
        actor: input.actor,
        verdicts: Object.fromEntries(input.verdicts),
    });
    const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
        body,
    });
    if (!response.ok) {
        throw new Error(`ackt ancestry report failed: ${response.status} ${response.statusText}`);
    }
}
