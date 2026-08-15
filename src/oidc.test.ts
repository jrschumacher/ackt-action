import { describe, expect, it } from "vitest";

import {
  buildTokenRequestUrl,
  mintOidcToken,
  oidcEndpointPresent,
  parseTokenResponse,
  workflowFileFromRef,
  FORK_DEGRADED_MESSAGE,
  OIDC_AUDIENCE,
  type TokenFetchLike,
} from "./oidc.js";

const REQUEST_URL = "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0";
const REQUEST_TOKEN = "runner-request-token";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJyZXBvc2l0b3J5IjoiYWNtZS93aWRnZXRzIn0.sig";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN, ...overrides };
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(response: { ok: boolean; status?: number; statusText?: string; body?: unknown }, calls: Call[] = []): TokenFetchLike {
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

describe("buildTokenRequestUrl", () => {
  it("appends the audience with '&' — the runner's URL already has a query string", () => {
    expect(buildTokenRequestUrl(REQUEST_URL)).toBe(`${REQUEST_URL}&audience=ackt.dev`);
  });

  it("defaults to the audience the ackt service verifies", () => {
    expect(OIDC_AUDIENCE).toBe("ackt.dev");
  });

  it("URL-encodes a non-trivial audience", () => {
    expect(buildTokenRequestUrl(REQUEST_URL, "https://ackt.dev")).toBe(`${REQUEST_URL}&audience=https%3A%2F%2Fackt.dev`);
  });
});

describe("workflowFileFromRef", () => {
  it("names the workflow file out of GITHUB_WORKFLOW_REF", () => {
    expect(workflowFileFromRef("acme/widgets/.github/workflows/ackt.yml@refs/heads/main")).toBe(".github/workflows/ackt.yml");
  });

  it("falls back to a generic hint when the ref is absent", () => {
    expect(workflowFileFromRef(undefined)).toContain(".github/workflows/");
    expect(workflowFileFromRef("")).toContain(".github/workflows/");
  });

  it("returns the ref's path unchanged when it isn't in the expected shape", () => {
    expect(workflowFileFromRef("weird-value@refs/heads/main")).toBe("weird-value");
  });
});

describe("parseTokenResponse", () => {
  it("returns the token value", () => {
    expect(parseTokenResponse({ value: JWT })).toBe(JWT);
  });

  it("throws on null", () => {
    expect(() => parseTokenResponse(null)).toThrow(/malformed/);
  });

  it("throws when 'value' is missing", () => {
    expect(() => parseTokenResponse({})).toThrow(/malformed/);
  });

  it("throws on an empty 'value' — an empty Bearer token is worse than no request", () => {
    expect(() => parseTokenResponse({ value: "" })).toThrow(/malformed/);
  });
});

describe("mintOidcToken", () => {
  it("mints a token from the runner's endpoint", async () => {
    const calls: Call[] = [];
    const token = await mintOidcToken(env(), fakeFetch({ ok: true, body: { value: JWT } }, calls));
    expect(token).toBe(JWT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${REQUEST_URL}&audience=ackt.dev`);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${REQUEST_TOKEN}`);
  });

  // The whole point of resolution 1: no silent degrade. A missing permission
  // is a workflow bug, and the message has to be enough to fix it.
  it("fails, naming the permission and the workflow file, when the request URL is absent", async () => {
    const missing = env({ ACTIONS_ID_TOKEN_REQUEST_URL: undefined, GITHUB_WORKFLOW_REF: "acme/widgets/.github/workflows/ackt.yml@refs/heads/main" });
    await expect(mintOidcToken(missing, fakeFetch({ ok: true, body: { value: JWT } }))).rejects.toThrow(/id-token: write/);
    await expect(mintOidcToken(missing, fakeFetch({ ok: true, body: { value: JWT } }))).rejects.toThrow(/\.github\/workflows\/ackt\.yml/);
  });

  it("fails when the request token is absent", async () => {
    await expect(mintOidcToken(env({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }), fakeFetch({ ok: true, body: { value: JWT } }))).rejects.toThrow(/id-token: write/);
  });

  it("treats empty-string variables as absent", async () => {
    await expect(mintOidcToken(env({ ACTIONS_ID_TOKEN_REQUEST_URL: "" }), fakeFetch({ ok: true, body: { value: JWT } }))).rejects.toThrow(/id-token: write/);
    await expect(mintOidcToken(env({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }), fakeFetch({ ok: true, body: { value: JWT } }))).rejects.toThrow(/id-token: write/);
  });

  it("never requests a token when the variables are missing", async () => {
    const calls: Call[] = [];
    await expect(mintOidcToken({}, fakeFetch({ ok: true, body: { value: JWT } }, calls))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("keeps the failure message on one line so it survives a workflow annotation", async () => {
    await expect(mintOidcToken({}, fakeFetch({ ok: true, body: { value: JWT } }))).rejects.toThrow(/^[^\n]+$/);
  });

  it("throws on a non-ok minting response", async () => {
    await expect(mintOidcToken(env(), fakeFetch({ ok: false, status: 403, statusText: "Forbidden" }))).rejects.toThrow(/403/);
  });

  it("throws on a malformed minting response rather than sending a bogus token", async () => {
    await expect(mintOidcToken(env(), fakeFetch({ ok: true, body: { oops: true } }))).rejects.toThrow(/malformed/);
  });
});

// ---------------------------------------------------------------------------
// I4. The same absence means two opposite things, and only the caller knows
// which — see index.ts, which pairs this with `isForkPullRequest`.
// ---------------------------------------------------------------------------

describe("oidcEndpointPresent", () => {
  it("is true when the runner exposed both variables", () => {
    expect(oidcEndpointPresent(env())).toBe(true);
  });

  it("is false when either variable is missing or empty", () => {
    expect(oidcEndpointPresent(env({ ACTIONS_ID_TOKEN_REQUEST_URL: undefined }))).toBe(false);
    expect(oidcEndpointPresent(env({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }))).toBe(false);
    expect(oidcEndpointPresent(env({ ACTIONS_ID_TOKEN_REQUEST_URL: "" }))).toBe(false);
    expect(oidcEndpointPresent(env({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }))).toBe(false);
  });

  it("agrees with mintOidcToken about what counts as absent", async () => {
    const absent = env({ ACTIONS_ID_TOKEN_REQUEST_URL: undefined });
    expect(oidcEndpointPresent(absent)).toBe(false);
    await expect(mintOidcToken(absent, fakeFetch({ ok: true, body: { value: JWT } }))).rejects.toThrow(/id-token: write/);
  });
});

describe("FORK_DEGRADED_MESSAGE", () => {
  // The previous behaviour was an error telling a maintainer to add a
  // permission that was already present. Each assertion below is one thing
  // that failure got wrong.
  it("names the fork as the cause", () => {
    expect(FORK_DEGRADED_MESSAGE).toContain("fork");
  });

  it("does not tell the reader to add a permission — the point is that nothing is missing", () => {
    expect(FORK_DEGRADED_MESSAGE).not.toContain("id-token: write");
    expect(FORK_DEGRADED_MESSAGE).toContain("nothing to add to the workflow file");
  });

  it("states exactly what is lost: recording and ancestry, not the check itself", () => {
    expect(FORK_DEGRADED_MESSAGE).toContain("not recorded");
    expect(FORK_DEGRADED_MESSAGE).toContain("ancestry is not reported");
  });

  it("survives a ::warning:: annotation — one line, no newlines to truncate at", () => {
    expect(FORK_DEGRADED_MESSAGE).not.toContain("\n");
  });
});
