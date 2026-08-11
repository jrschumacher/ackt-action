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
  /**
   * Every head this actor has attested on this pull request, oldest first —
   * phase one of the two-phase ancestry exchange. `ancestry.ts` walks this
   * list with `git merge-base --is-ancestor` against the PR's real current
   * head, and `postAncestry` (below) reports the verdicts back.
   *
   * The service omits this key entirely for a caller authorized only by its
   * browser-session heuristic (not this Action's path — it always holds an
   * OIDC token) — so this defaults to `[]` rather than throwing when the key
   * is absent or malformed. Only `attested`/`statement_sha256` are the
   * documented, guaranteed shape; this is best-effort by design.
   */
  readonly attestedHeads: readonly string[];
}

export function buildAcktQueryUrl(input: AcktQueryInput): string {
  const url = new URL("/api/v1/ackt", input.service);
  url.searchParams.set("repo", input.repo);
  url.searchParams.set("pr", String(input.pr));
  url.searchParams.set("actor", input.actor);
  url.searchParams.set("head", input.head);
  return url.toString();
}

function parseAttestedHeads(record: Record<string, unknown>): readonly string[] {
  const raw = record.attested_heads;
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is string => typeof h === "string");
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
export function parseAcktResponse(data: unknown): AcktQueryResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("malformed ackt response: expected an object");
  }
  const record = data as Record<string, unknown>;
  if (typeof record.attested !== "boolean") {
    throw new Error("malformed ackt response: 'attested' must be a boolean");
  }
  const statementSha256 = typeof record.statement_sha256 === "string" ? record.statement_sha256 : null;
  return { attested: record.attested, statementSha256, attestedHeads: parseAttestedHeads(record) };
}

/**
 * Structural subset of `fetch`'s return shape — deliberately not `typeof
 * fetch` / `Response`, so tests can pass a plain object literal instead of
 * constructing a real `Response`. `method`/`body` are optional so the same
 * type covers both `queryAckt`'s GET and `postAncestry`'s POST below.
 */
export type FetchLike = (
  url: string,
  init: { readonly method?: string; readonly headers: Record<string, string>; readonly body?: string },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}>;

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
export async function queryAckt(input: AcktQueryInput, fetchImpl: FetchLike, token: string): Promise<AcktQueryResult> {
  const url = buildAcktQueryUrl(input);
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`ackt query failed: ${response.status} ${response.statusText}`);
  }
  return parseAcktResponse(await response.json());
}

// ---------------------------------------------------------------------------
// POST /api/v1/ancestry — phase three of the exchange: report the verdicts
// ancestry.ts computed locally.
// ---------------------------------------------------------------------------

/** The only two verdicts this Action ever reports — see ancestry.ts's `isAncestor`. `current`/`unknown` are never sent: the service determines `current` itself, and `unknown` is the absence of a verdict, not one. */
export type AncestryVerdict = "advanced" | "rewritten";

export interface PostAncestryInput {
  readonly service: string;
  readonly repo: string;
  readonly pr: number;
  readonly actor: string;
  readonly verdicts: ReadonlyMap<string, AncestryVerdict>;
}

export function buildAncestryPostUrl(service: string): string {
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
export async function postAncestry(input: PostAncestryInput, fetchImpl: FetchLike, token: string): Promise<void> {
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
