import { describe, expect, it } from "vitest";

import { BOT_LOGIN, decideTrigger, isForkPullRequest } from "./trigger.js";

function pullRequestEvent(action: string): unknown {
  return { action, pull_request: { number: 1 } };
}

function issueCommentEvent(overrides: {
  action: string;
  body: string;
  login?: string;
  sender?: string;
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
    ...(overrides.sender !== undefined ? { sender: { login: overrides.sender } } : {}),
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

  it("does not self-trigger on the bot's own checkbox-resetting edit (sender is the bot)", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({
        action: "edited",
        body: "- [ ] Re-check attestation",
        login: BOT_LOGIN,
        sender: BOT_LOGIN,
        previousBody: "- [x] Re-check attestation",
      }),
    );
    expect(decision.act).toBe(false);
    expect(decision.reason).toMatch(/bot itself/);
  });

  it("acts on a human-sent edit of the bot's own comment — the checkbox click itself", () => {
    // This is the bug: the comment is always bot-authored (the checkbox
    // lives on the bot's own comment by design), so keying the guard on the
    // comment *author* instead of the edit *sender* meant this could never
    // fire. `login` here is deliberately the bot — only `sender` (the human
    // who clicked) should matter.
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({
        action: "edited",
        body: "- [x] Re-check attestation",
        login: BOT_LOGIN,
        sender: "a-human-reviewer",
        previousBody: "- [ ] Re-check attestation",
      }),
    );
    expect(decision.act).toBe(true);
    expect(decision.reason).toMatch(/checkbox newly checked/);
  });

  it("does not act on a human-sent edit when the box was already checked (no transition)", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({
        action: "edited",
        body: "- [x] Re-check attestation",
        login: BOT_LOGIN,
        sender: "a-human-reviewer",
        previousBody: "- [x] Re-check attestation",
      }),
    );
    expect(decision.act).toBe(false);
    expect(decision.reason).not.toMatch(/bot itself/);
  });

  it("fails closed — refuses when an edited comment has no sender at all", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({
        action: "edited",
        body: "- [x] Re-check attestation",
        login: BOT_LOGIN,
        previousBody: "- [ ] Re-check attestation",
        // no `sender` override — simulates a malformed/unexpected payload
      }),
    );
    expect(decision.act).toBe(false);
    expect(decision.reason).toMatch(/no sender/);
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
      issueCommentEvent({ action: "edited", body: "- [x] Re-check attestation", sender: "someone", previousBody: "- [ ] Re-check attestation" }),
    );
    expect(decision.act).toBe(true);
  });

  it("does not act when the checkbox was already checked", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [x] Re-check attestation", sender: "someone", previousBody: "- [x] Re-check attestation" }),
    );
    expect(decision.act).toBe(false);
  });

  it("does not act when the checkbox remains unchecked", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [ ] Re-check attestation", sender: "someone", previousBody: "- [ ] Re-check attestation" }),
    );
    expect(decision.act).toBe(false);
  });

  it("does not act when the checkbox goes from checked to unchecked", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [ ] Re-check attestation", sender: "someone", previousBody: "- [x] Re-check attestation" }),
    );
    expect(decision.act).toBe(false);
  });

  it("does not act on an edit with no previous body available and no checkbox checked", () => {
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [ ] Re-check attestation", sender: "someone" }),
    );
    expect(decision.act).toBe(false);
  });

  it("acts on an edit with no previous body available but a checked box now present", () => {
    // No `changes.body.from` means we can't know the prior state; treat it
    // as previously unchecked so a checked box still triggers rather than
    // being silently swallowed.
    const decision = decideTrigger(
      "issue_comment",
      issueCommentEvent({ action: "edited", body: "- [x] Re-check attestation", sender: "someone" }),
    );
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

// ---------------------------------------------------------------------------
// I4. GitHub issues no OIDC token on a fork-origin `pull_request`, whatever
// the workflow's `permissions:` say — so this predicate decides whether an
// absent minting endpoint is the consumer's bug or GitHub's policy.
// ---------------------------------------------------------------------------

/** `baseRepo: false` means the payload carries no readable base repository name at all. */
function forkShapedEvent(headRepo: string | null, baseRepo: string | false = "acme/widgets"): unknown {
  return {
    action: "opened",
    pull_request: {
      number: 1,
      head: { repo: headRepo === null ? null : { full_name: headRepo } },
      base: baseRepo === false ? {} : { repo: { full_name: baseRepo } },
    },
  };
}

describe("isForkPullRequest", () => {
  it("is true when the head repository differs from the base repository", () => {
    expect(isForkPullRequest("pull_request", forkShapedEvent("contributor/widgets"))).toBe(true);
  });

  it("is false for a same-repository pull request — a missing token there really is a missing permission", () => {
    expect(isForkPullRequest("pull_request", forkShapedEvent("acme/widgets"))).toBe(false);
  });

  // The base repository's own fork can open internal PRs; those are
  // same-repository runs and do mint a token normally.
  it("is false for a pull request internal to a fork", () => {
    expect(isForkPullRequest("pull_request", forkShapedEvent("contributor/widgets", "contributor/widgets"))).toBe(false);
  });

  // `issue_comment` runs in the base repository's context with the base
  // repository's permissions, and mints a token even when the PR came from a
  // fork — so an absent endpoint there is a real misconfiguration.
  it("is false for issue_comment, whatever the payload looks like", () => {
    expect(isForkPullRequest("issue_comment", forkShapedEvent("contributor/widgets"))).toBe(false);
  });

  it("is false for an event carrying no pull_request at all", () => {
    expect(isForkPullRequest("pull_request", { action: "opened" })).toBe(false);
    expect(isForkPullRequest("pull_request", null)).toBe(false);
  });

  // A deleted head repository is certainly not the base repository, and the
  // degraded path is the safe direction for something we cannot read.
  it("treats a null head repository as a fork", () => {
    expect(isForkPullRequest("pull_request", forkShapedEvent(null))).toBe(true);
  });

  // Without a base name there is nothing to compare against; fall back to the
  // old, loud behaviour rather than silently degrading every run.
  it("is false when the base repository name is unreadable", () => {
    expect(isForkPullRequest("pull_request", forkShapedEvent("contributor/widgets", false))).toBe(false);
  });
});
