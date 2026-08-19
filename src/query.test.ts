import { describe, expect, it } from "vitest";

import {
  buildAcktQueryUrl,
  buildAncestryPostUrl,
  buildAttestationsQueryUrl,
  parseAcktResponse,
  parseAttestationRecords,
  postAncestry,
  queryAckt,
  queryAttestations,
  type FetchLike,
} from "./query.js";

const INPUT = {
  service: "https://ackt.dev",
  repo: "opentdf/platform",
  pr: 3794,
  actor: "jrschumacher",
  head: "4968d60a36f23ca29993221a36828213fe43b304",
};

describe("buildAcktQueryUrl", () => {
  it("builds the expected path and query parameters", () => {
    const url = new URL(buildAcktQueryUrl(INPUT));
    expect(url.origin + url.pathname).toBe("https://ackt.dev/api/v1/ackt");
    expect(url.searchParams.get("repo")).toBe("opentdf/platform");
    expect(url.searchParams.get("pr")).toBe("3794");
    expect(url.searchParams.get("actor")).toBe("jrschumacher");
    expect(url.searchParams.get("head")).toBe(INPUT.head);
  });

  it("respects a service base URL with a trailing slash", () => {
    const url = buildAcktQueryUrl({ ...INPUT, service: "https://ackt.dev/" });
    expect(url.startsWith("https://ackt.dev/api/v1/ackt?")).toBe(true);
  });

  it("URL-encodes special characters in query values", () => {
    const url = new URL(buildAcktQueryUrl({ ...INPUT, actor: "weird actor" }));
    expect(url.searchParams.get("actor")).toBe("weird actor");
    expect(url.toString()).toContain("actor=weird+actor");
  });
});

describe("parseAcktResponse", () => {
  it("parses an attested response", () => {
    const result = parseAcktResponse({ attested: true, statement_sha256: "abc123" });
    expect(result).toEqual({ attested: true, statementSha256: "abc123", attestedHeads: [] });
  });

  it("parses a not-attested response with no statement hash", () => {
    const result = parseAcktResponse({ attested: false });
    expect(result).toEqual({ attested: false, statementSha256: null, attestedHeads: [] });
  });

  it("throws on null", () => {
    expect(() => parseAcktResponse(null)).toThrow();
  });

  it("throws on a non-object", () => {
    expect(() => parseAcktResponse("attested")).toThrow();
  });

  it("throws when 'attested' is missing", () => {
    expect(() => parseAcktResponse({})).toThrow();
  });

  it("throws when 'attested' is not a boolean", () => {
    expect(() => parseAcktResponse({ attested: "yes" })).toThrow();
  });

  it("ignores a non-string statement_sha256 rather than throwing", () => {
    const result = parseAcktResponse({ attested: true, statement_sha256: 12345 });
    expect(result).toEqual({ attested: true, statementSha256: null, attestedHeads: [] });
  });

  it("ignores an unrelated unknown field, so the service can add some without breaking this action", () => {
    const result = parseAcktResponse({ attested: true, statement_sha256: "abc", some_future_field: 42 });
    expect(result).toEqual({ attested: true, statementSha256: "abc", attestedHeads: [] });
  });

  // Phase one of the two-phase ancestry exchange
  // (docs/superpowers/specs/2026-08-11-dashboard-design.md) — see
  // AcktQueryResult's own doc comment for why this field is held to a
  // looser standard than 'attested'/'statement_sha256'.
  it("parses attested_heads when present", () => {
    const heads = ["1".repeat(40), "2".repeat(40)];
    const result = parseAcktResponse({ attested: true, attested_heads: heads });
    expect(result.attestedHeads).toEqual(heads);
  });

  it("defaults attestedHeads to [] when the key is absent — the participant-session case", () => {
    const result = parseAcktResponse({ attested: false });
    expect(result.attestedHeads).toEqual([]);
  });

  it("defaults attestedHeads to [] rather than throwing when attested_heads is not an array", () => {
    const result = parseAcktResponse({ attested: true, attested_heads: "not-an-array" });
    expect(result.attestedHeads).toEqual([]);
  });

  it("filters out non-string entries from attested_heads rather than throwing", () => {
    const result = parseAcktResponse({ attested: true, attested_heads: ["a".repeat(40), 42, null, "b".repeat(40)] });
    expect(result.attestedHeads).toEqual(["a".repeat(40), "b".repeat(40)]);
  });
});

describe("queryAckt", () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.header.signature";

  interface Call {
    url: string;
    headers: Record<string, string>;
  }

  function fakeFetch(response: { ok: boolean; status?: number; statusText?: string; body?: unknown }, calls: Call[] = []): FetchLike {
    return async (url, init) => {
      calls.push({ url, headers: init.headers });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        statusText: response.statusText ?? "",
        json: async () => response.body,
      };
    };
  }

  it("returns the parsed result on success", async () => {
    const result = await queryAckt(INPUT, fakeFetch({ ok: true, body: { attested: true, statement_sha256: "deadbeef" } }), TOKEN);
    expect(result).toEqual({ attested: true, statementSha256: "deadbeef", attestedHeads: [] });
  });

  it("sends the OIDC token as an Authorization: Bearer header", async () => {
    const calls: Call[] = [];
    await queryAckt(INPUT, fakeFetch({ ok: true, body: { attested: false } }, calls), TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).toBe(buildAcktQueryUrl(INPUT));
  });

  it("never puts the token in the URL", async () => {
    const calls: Call[] = [];
    await queryAckt(INPUT, fakeFetch({ ok: true, body: { attested: false } }, calls), TOKEN);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("throws on a non-ok HTTP response", async () => {
    await expect(queryAckt(INPUT, fakeFetch({ ok: false, status: 503, statusText: "Service Unavailable" }), TOKEN)).rejects.toThrow(/503/);
  });

  it("throws on a malformed 200 response", async () => {
    await expect(queryAckt(INPUT, fakeFetch({ ok: true, body: { oops: true } }), TOKEN)).rejects.toThrow(/malformed/);
  });

  it("carries attested_heads through end to end", async () => {
    const heads = ["a".repeat(40)];
    const result = await queryAckt(INPUT, fakeFetch({ ok: true, body: { attested: true, statement_sha256: "abc", attested_heads: heads } }), TOKEN);
    expect(result).toEqual({ attested: true, statementSha256: "abc", attestedHeads: heads });
  });
});

describe("buildAncestryPostUrl", () => {
  it("builds the expected path", () => {
    expect(buildAncestryPostUrl("https://ackt.dev")).toBe("https://ackt.dev/api/v1/ancestry");
  });

  it("respects a service base URL with a trailing slash", () => {
    expect(buildAncestryPostUrl("https://ackt.dev/")).toBe("https://ackt.dev/api/v1/ancestry");
  });
});

describe("postAncestry", () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.header.signature";

  interface Call {
    url: string;
    method?: string | undefined;
    headers: Record<string, string>;
    body?: string | undefined;
  }

  function fakePostFetch(response: { ok: boolean; status?: number; statusText?: string }, calls: Call[] = []): FetchLike {
    return async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        statusText: response.statusText ?? "",
        json: async () => ({}),
      };
    };
  }

  const ANCESTRY_INPUT = {
    service: "https://ackt.dev",
    repo: "opentdf/platform",
    pr: 3794,
    actor: "jrschumacher",
    verdicts: new Map<string, "advanced" | "rewritten">([
      ["1".repeat(40), "advanced"],
      ["2".repeat(40), "rewritten"],
    ]),
  };

  it("posts to /api/v1/ancestry with the OIDC token as a Bearer header", async () => {
    const calls: Call[] = [];
    await postAncestry(ANCESTRY_INPUT, fakePostFetch({ ok: true }, calls), TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ackt.dev/api/v1/ancestry");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends repo, pr, actor, and verdicts as a plain object body", async () => {
    const calls: Call[] = [];
    await postAncestry(ANCESTRY_INPUT, fakePostFetch({ ok: true }, calls), TOKEN);
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      repo: "opentdf/platform",
      pr: 3794,
      actor: "jrschumacher",
      verdicts: { ["1".repeat(40)]: "advanced", ["2".repeat(40)]: "rewritten" },
    });
  });

  it("never puts the token in the URL", async () => {
    const calls: Call[] = [];
    await postAncestry(ANCESTRY_INPUT, fakePostFetch({ ok: true }, calls), TOKEN);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("throws on a non-ok HTTP response", async () => {
    await expect(postAncestry(ANCESTRY_INPUT, fakePostFetch({ ok: false, status: 401, statusText: "Unauthorized" }), TOKEN)).rejects.toThrow(/401/);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/attestations — the records the comment's timestamps and history
// are built from (I2/I3).
// ---------------------------------------------------------------------------

describe("buildAttestationsQueryUrl", () => {
  it("builds the expected path and query parameters", () => {
    const url = new URL(buildAttestationsQueryUrl({ service: "https://ackt.dev", repo: "opentdf/platform", pr: 3794 }));
    expect(url.origin + url.pathname).toBe("https://ackt.dev/api/v1/attestations");
    expect(url.searchParams.get("repo")).toBe("opentdf/platform");
    expect(url.searchParams.get("pr")).toBe("3794");
  });

  it("respects a service base URL with a trailing slash — a self-hosted deployment queries itself", () => {
    const url = buildAttestationsQueryUrl({ service: "https://ackt.example/", repo: "o/r", pr: 1 });
    expect(url.startsWith("https://ackt.example/api/v1/attestations?")).toBe(true);
  });
});

describe("parseAttestationRecords", () => {
  const ROW = { actor: "jrschumacher", head: "a".repeat(40), verified_at: "2026-08-15T14:02:03Z" };

  it("decodes actor, head and verified_at, and ignores the rest of the record shape", () => {
    const rows = parseAttestationRecords({ records: [{ ...ROW, credential_id: "x", aaguid: "y", uv: true }] });
    expect(rows).toEqual([{ actor: "jrschumacher", head: "a".repeat(40), verifiedAt: "2026-08-15T14:02:03Z" }]);
  });

  it("preserves the service's verified_at ASC order — oldest first is what makes a history read as one", () => {
    const older = { ...ROW, head: "1".repeat(40), verified_at: "2026-08-09T12:23:00Z" };
    const newer = { ...ROW, head: "2".repeat(40), verified_at: "2026-08-15T14:02:03Z" };
    expect(parseAttestationRecords({ records: [older, newer] }).map((r) => r.head)).toEqual([older.head, newer.head]);
  });

  // The opposite policy to parseAcktResponse, deliberately: `attested` is a
  // security decision and must fail loudly; these records are decoration and
  // must never be able to fail a run. See the function's doc comment.
  it("returns [] rather than throwing for a non-object body", () => {
    expect(parseAttestationRecords(null)).toEqual([]);
    expect(parseAttestationRecords("nope")).toEqual([]);
  });

  it("returns [] rather than throwing when records is absent or not an array", () => {
    expect(parseAttestationRecords({})).toEqual([]);
    expect(parseAttestationRecords({ records: "nope" })).toEqual([]);
  });

  it("skips individual malformed rows rather than throwing away the good ones", () => {
    const rows = parseAttestationRecords({ records: [ROW, null, 42, { actor: "x" }, { ...ROW, verified_at: 5 }, { ...ROW, head: "b".repeat(40) }] });
    expect(rows.map((r) => r.head)).toEqual(["a".repeat(40), "b".repeat(40)]);
  });
});

describe("queryAttestations", () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.header.signature";
  const RECORDS_INPUT = { service: "https://ackt.dev", repo: "opentdf/platform", pr: 3794 };

  interface Call {
    url: string;
    headers: Record<string, string>;
  }

  function fakeFetch(response: { ok: boolean; status?: number; statusText?: string; body?: unknown }, calls: Call[] = []): FetchLike {
    return async (url, init) => {
      calls.push({ url, headers: init.headers });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        statusText: response.statusText ?? "",
        json: async () => response.body,
      };
    };
  }

  it("sends the OIDC token as an Authorization: Bearer header", async () => {
    const calls: Call[] = [];
    await queryAttestations(RECORDS_INPUT, fakeFetch({ ok: true, body: { records: [] } }, calls), TOKEN);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).toBe(buildAttestationsQueryUrl(RECORDS_INPUT));
  });

  // The fork case (I4): no token exists to send, so the header is omitted
  // entirely rather than sent empty — that is the unauthenticated query the
  // service already answers for a public repository.
  it("omits the Authorization header entirely when there is no token", async () => {
    const calls: Call[] = [];
    await queryAttestations(RECORDS_INPUT, fakeFetch({ ok: true, body: { records: [] } }, calls), null);
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.headers.Accept).toBe("application/json");
  });

  it("throws on a non-ok HTTP response — the call site is what treats that as non-fatal", async () => {
    await expect(queryAttestations(RECORDS_INPUT, fakeFetch({ ok: false, status: 404, statusText: "Not Found" }), null)).rejects.toThrow(/404/);
  });
});

describe("queryAckt without a token — the fork-degraded path (I4)", () => {
  it("omits the Authorization header rather than sending an empty Bearer", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ attested: false }) };
    };
    const result = await queryAckt(INPUT, fetchImpl, null);
    expect(result.attested).toBe(false);
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(Object.keys(calls[0]?.headers ?? {})).toEqual(["Accept"]);
  });
});
