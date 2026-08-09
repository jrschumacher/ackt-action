/**
 * Pure URL construction and response parsing for `GET /api/v1/ackt`
 * (docs/superpowers/specs/2026-08-08-no-app-design.md, "Query by head, not
 * timestamp"). The one impure piece — calling `fetch` — is a thin wrapper
 * that takes the fetch implementation as a parameter, so tests supply a fake
 * and never touch the network.
 */

export interface AcktQueryInput {
  readonly service: string;
  readonly repo: string;
  readonly pr: number;
  readonly actor: string;
  readonly head: string;
}

export interface AcktQueryResult {
  readonly attested: boolean;
  readonly statementSha256: string | null;
}

export function buildAcktQueryUrl(input: AcktQueryInput): string {
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
export function parseAcktResponse(data: unknown): AcktQueryResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("malformed ackt response: expected an object");
  }
  const record = data as Record<string, unknown>;
  if (typeof record.attested !== "boolean") {
    throw new Error("malformed ackt response: 'attested' must be a boolean");
  }
  const statementSha256 = typeof record.statement_sha256 === "string" ? record.statement_sha256 : null;
  return { attested: record.attested, statementSha256 };
}

/**
 * Structural subset of `fetch`'s return shape — deliberately not `typeof
 * fetch` / `Response`, so tests can pass a plain object literal instead of
 * constructing a real `Response`.
 */
export type FetchLike = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}>;

export async function queryAckt(input: AcktQueryInput, fetchImpl: FetchLike): Promise<AcktQueryResult> {
  const url = buildAcktQueryUrl(input);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`ackt query failed: ${response.status} ${response.statusText}`);
  }
  return parseAcktResponse(await response.json());
}
