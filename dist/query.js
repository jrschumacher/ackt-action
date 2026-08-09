/**
 * Pure URL construction and response parsing for `GET /api/v1/ackt`
 * (docs/superpowers/specs/2026-08-08-no-app-design.md, "Query by head, not
 * timestamp"). The one impure piece — calling `fetch` — is a thin wrapper
 * that takes the fetch implementation as a parameter, so tests supply a fake
 * and never touch the network.
 */
export function buildAcktQueryUrl(input) {
    const url = new URL("/api/v1/ackt", input.service);
    url.searchParams.set("repo", input.repo);
    url.searchParams.set("pr", String(input.pr));
    url.searchParams.set("actor", input.actor);
    url.searchParams.set("head", input.head);
    return url.toString();
}
/**
 * Throws on anything that isn't the documented `{attested: boolean}` shape.
 * A malformed response should fail the run loudly, not silently read as
 * "not attested" — that would be a fail-open on a service outage or a
 * breaking API change, exactly backwards for a security control.
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
    return { attested: record.attested, statementSha256 };
}
export async function queryAckt(input, fetchImpl) {
    const url = buildAcktQueryUrl(input);
    const response = await fetchImpl(url);
    if (!response.ok) {
        throw new Error(`ackt query failed: ${response.status} ${response.statusText}`);
    }
    return parseAcktResponse(await response.json());
}
