import { describe, expect, it } from "vitest";

import { buildAcktQueryUrl, parseAcktResponse, queryAckt, type FetchLike } from "./query.js";

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
    expect(result).toEqual({ attested: true, statementSha256: "abc123" });
  });

  it("parses a not-attested response with no statement hash", () => {
    const result = parseAcktResponse({ attested: false });
    expect(result).toEqual({ attested: false, statementSha256: null });
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
    expect(result).toEqual({ attested: true, statementSha256: null });
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
    expect(result).toEqual({ attested: true, statementSha256: "deadbeef" });
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

  it("ignores unknown response fields, so the service can add some without breaking this action", async () => {
    const result = await queryAckt(INPUT, fakeFetch({ ok: true, body: { attested: true, statement_sha256: "abc", attested_heads: ["a".repeat(40)] } }), TOKEN);
    expect(result).toEqual({ attested: true, statementSha256: "abc" });
  });
});
