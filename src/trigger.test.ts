import { describe, expect, it } from "vitest";

import { BOT_LOGIN, decideTrigger } from "./trigger.js";

function pullRequestEvent(action: string): unknown {
  return { action, pull_request: { number: 1 } };
}

function issueCommentEvent(overrides: {
  action: string;
  body: string;
  login?: string;
  isPullRequest?: boolean;
  previousBody?: string;
}): unknown {
  return {
    action: overrides.action,
    issue: {
      number: 1,
      pull_request: overrides.isPullRequest === false ? undefined : { url: "https://api.github.com/..." },
    },
    comment: {
      id: 99,
      body: overrides.body,
      user: { login: overrides.login ?? "someone" },
    },
    ...(overrides.previousBody !== undefined ? { changes: { body: { from: overrides.previousBody } } } : {}),
  };
}

describe("decideTrigger — pull_request", () => {
  it.each(["opened", "reopened", "synchronize"])("acts on '%s'", (action) => {
    const decision = decideTrigger("pull_request", pullRequestEvent(action));
    expect(decision.act).toBe(true);
  });

  it.each(["closed", "labeled", "assigned", "edited", "ready_for_review"])("does not act on '%s'", (action) => {
    const decision = decideTrigger("pull_request", pullRequestEvent(action));
    expect(decision.act).toBe(false);
  });
});

describe("decideTrigger — issue_comment guards", () => {
  it("does not act when the comment is on an issue, not a pull request", () => {
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "created", body: "/ackt", isPullRequest: false }));
    expect(decision.act).toBe(false);
    expect(decision.reason).toMatch(/issue, not a pull request/);
  });

  it("does not self-trigger on a comment from the bot itself (created)", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "created", body: "/ackt", login: BOT_LOGIN }),
    );
    expect(decision.act).toBe(false);
    expect(decision.reason).toMatch(/bot itself/);
  });

  it("does not self-trigger on the bot's own checkbox-resetting edit", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [ ] Re-check attestation", login: BOT_LOGIN, previousBody: "- [x] Re-check attestation" }),
    );
    expect(decision.act).toBe(false);
    expect(decision.reason).toMatch(/bot itself/);
  });
});

describe("decideTrigger — issue_comment created, /ackt keyword", () => {
  it("acts when /ackt is the whole comment", () => {
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "created", body: "/ackt" }));
    expect(decision.act).toBe(true);
  });

  it("acts when /ackt starts a line in a multi-line comment", () => {
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "created", body: "please re-check:\n/ackt\nthanks" }));
    expect(decision.act).toBe(true);
  });

  it("acts when /ackt is preceded only by whitespace", () => {
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "created", body: "   /ackt" }));
    expect(decision.act).toBe(true);
  });

  it("does NOT act when /ackt appears mid-sentence", () => {
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "created", body: "can someone run /ackt on this?" }));
    expect(decision.act).toBe(false);
  });

  it("does not act on an unrelated new comment", () => {
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "created", body: "nice work!" }));
    expect(decision.act).toBe(false);
  });
});

describe("decideTrigger — issue_comment edited, checkbox transitions", () => {
  it("acts when the checkbox goes from unchecked to checked", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [x] Re-check attestation", previousBody: "- [ ] Re-check attestation" }),
    );
    expect(decision.act).toBe(true);
  });

  it("does not act when the checkbox was already checked", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [x] Re-check attestation", previousBody: "- [x] Re-check attestation" }),
    );
    expect(decision.act).toBe(false);
  });

  it("does not act when the checkbox remains unchecked", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [ ] Re-check attestation", previousBody: "- [ ] Re-check attestation" }),
    );
    expect(decision.act).toBe(false);
  });

  it("does not act when the checkbox goes from checked to unchecked", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [ ] Re-check attestation", previousBody: "- [x] Re-check attestation" }),
    );
    expect(decision.act).toBe(false);
  });

  it("does not act on an edit with no previous body available and no checkbox checked", () => {
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "edited", body: "- [ ] Re-check attestation" }));
    expect(decision.act).toBe(false);
  });

  it("acts on an edit with no previous body available but a checked box now present", () => {
    // No `changes.body.from` means we can't know the prior state; treat it
    // as previously unchecked so a checked box still triggers rather than
    // being silently swallowed.
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "edited", body: "- [x] Re-check attestation" }));
    expect(decision.act).toBe(true);
  });
});

describe("decideTrigger — other issue_comment actions and event types", () => {
  it("does not act on issue_comment deleted", () => {
    const decision = decideTrigger("issue_comment", issueCommentEvent({ action: "deleted", body: "/ackt" }));
    expect(decision.act).toBe(false);
  });

  it("does not act on an unhandled event type", () => {
    const decision = decideTrigger("push", { ref: "refs/heads/main" });
    expect(decision.act).toBe(false);
  });
});
