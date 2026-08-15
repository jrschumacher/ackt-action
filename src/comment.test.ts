import { describe, expect, it } from "vitest";

import {
  ACKT_COMMENT_MARKER,
  BOT_LOGIN,
  escapeMarkdown,
  findAcktComment,
  formatUtc,
  isCheckboxChecked,
  renderComment,
  resetCheckbox,
  type AttestationRecord,
  type CommentInput,
  type GithubComment,
} from "./comment.js";

const BASE_INPUT: CommentInput = {
  service: "https://ackt.dev",
  owner: "opentdf",
  repo: "platform",
  pr: 3794,
  actor: "jrschumacher",
  headSha: "4968d60a36f23ca29993221a36828213fe43b304",
  attested: false,
};

const BUTTON = "[![Attest this PR](https://ackt.dev/attest-button.svg)]";
const FOOTER_LINE = "powered by [ackt.dev](https://ackt.dev)";

/** Every state, keyed by what it is, so the shared-shape suites can walk all three. */
const STATES: ReadonlyArray<readonly [string, CommentInput]> = [
  ["awaiting", BASE_INPUT],
  ["attested", { ...BASE_INPUT, attested: true, recordedAt: "2026-08-09 12:23" }],
  [
    "stale",
    {
      ...BASE_INPUT,
      headSha: "91acd0400000000000000000000000000000000",
      priorAttestations: [{ actor: "jrschumacher", headSha: "e0b3f72c1a4d9f0b5e6a7c8d9e0f1a2b3c4d5e6f", recordedAt: "2026-08-09 12:23" }],
    },
  ],
];

describe("renderComment", () => {
  it("always contains the marker, in every state", () => {
    expect(renderComment(BASE_INPUT)).toContain(ACKT_COMMENT_MARKER);
    expect(renderComment({ ...BASE_INPUT, attested: true, recordedAt: "2026-08-09 12:23" })).toContain(ACKT_COMMENT_MARKER);
    expect(
      renderComment({
        ...BASE_INPUT,
        priorAttestations: [{ actor: "jrschumacher", headSha: "e0b3f72c1a4d9f0b5e6a7c8d9e0f1a2b3c4d5e6f", recordedAt: "2026-08-09 12:23" }],
      }),
    ).toContain(ACKT_COMMENT_MARKER);
  });

  it("updates the link's head segment when the head changes — the whole point of carrying it here", () => {
    const newHead = "9999999999999999999999999999999999999999";
    const body = renderComment({ ...BASE_INPUT, headSha: newHead });
    expect(body).toContain(`https://ackt.dev/a/opentdf/platform/3794/${newHead}`);
    expect(body).not.toContain(BASE_INPUT.headSha);
  });

  it("is stable — identical input produces identical output", () => {
    expect(renderComment(BASE_INPUT)).toBe(renderComment(BASE_INPUT));
  });
});

describe("renderComment — the shape all three states share", () => {
  it.each(STATES)("%s: uses the same heading, with no state suffix and no glyph", (_name, input) => {
    const body = renderComment(input);
    expect(body).toContain("### Human review attestation\n");
    expect(body).not.toContain("Human review attestation —");
    expect(body).not.toContain("✔");
    expect(body).not.toContain("⚠");
  });

  it.each(STATES)("%s: ends with the footer, then the marker", (_name, input) => {
    const body = renderComment(input);
    expect(body.endsWith(`\n---\n${FOOTER_LINE}\n\n${ACKT_COMMENT_MARKER}`)).toBe(true);
  });

  it.each(STATES)("%s: has a blank line before the footer rule, so `---` is a rule and not a setext underline", (_name, input) => {
    expect(renderComment(input)).toContain("\n\n---\n");
  });

  it.each(STATES)("%s: has no context line repeating the PR title or branch", (_name, input) => {
    expect(renderComment(input)).not.toContain("<sub>");
  });

  it.each(STATES)("%s: does not advertise the /ackt slash command", (_name, input) => {
    // trigger.ts still honours it; the comment just stopped explaining two
    // re-trigger paths where one click does. Matched with its backticks
    // because the bare string `/ackt` is also a substring of `https://ackt.dev`.
    expect(renderComment(input)).not.toContain("`/ackt`");
  });
});

describe("renderComment — the attest button", () => {
  it("is a linked image whose alt text is the call to action, so it degrades to a working text link", () => {
    // If camo is down, images are blocked, or a screen reader is reading the
    // comment, the alt text is the entire CTA.
    const body = renderComment(BASE_INPUT);
    expect(body).toContain(`${BUTTON}(https://ackt.dev/a/opentdf/platform/3794/${BASE_INPUT.headSha})`);
  });

  it("appears in both states that have something to attest", () => {
    expect(renderComment(BASE_INPUT)).toContain(BUTTON);
    expect(renderComment(STATES[2]![1])).toContain(BUTTON);
  });

  it("is absent from the attested state — there is nothing left to attest", () => {
    expect(renderComment(STATES[1]![1])).not.toContain("attest-button.svg");
  });

  it("takes the asset from the configured service, so a self-hosted deployment serves its own", () => {
    const body = renderComment({ ...BASE_INPUT, service: "https://ackt.example.com" });
    expect(body).toContain("[![Attest this PR](https://ackt.example.com/attest-button.svg)]");
    expect(body).not.toContain("https://ackt.dev/attest-button.svg");
  });
});

describe("renderComment — awaiting", () => {
  it("says, in one line, that nobody has attested the current commit", () => {
    const body = renderComment(BASE_INPUT);
    expect(body).toContain("Nobody has attested `4968d60` yet.");
  });

  it("does not restate that the attestation covers exactly this commit — naming the SHA already says it", () => {
    expect(renderComment(BASE_INPUT)).not.toContain("covers exactly");
  });

  it("keeps the re-check checkbox, unchecked, under the button", () => {
    const body = renderComment(BASE_INPUT);
    expect(body).toContain("- [ ] Re-check after attesting");
    expect(body.indexOf(BUTTON)).toBeLessThan(body.indexOf("- [ ]"));
  });

  it("is short: heading, button, one sentence, the checkbox, the two footer lines, the marker", () => {
    // A count, not a snapshot, so it fails loudly the moment a line creeps
    // back in — which is exactly how the old render got verbose.
    const lines = renderComment(BASE_INPUT).split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(7);
  });
});

describe("renderComment — attested", () => {
  const input: CommentInput = { ...BASE_INPUT, attested: true, recordedAt: "2026-08-09 12:23" };

  it("states who attested what and when, in a sentence rather than a one-row table", () => {
    const body = renderComment(input);
    expect(body).toContain("[@jrschumacher](https://github.com/jrschumacher) attested `4968d60` on 2026-08-09 12:23 UTC.");
    expect(body).not.toContain("| Author | Commit | Recorded (UTC) |");
  });

  it("claims nothing about the diff's quality — only that a person read it at that commit", () => {
    const body = renderComment(input);
    expect(body).not.toMatch(/approved|reviewed and|looks good|verified the/i);
  });

  it("omits the timestamp clause rather than rendering an empty one when recordedAt is absent", () => {
    const body = renderComment({ ...BASE_INPUT, attested: true });
    expect(body).toContain("attested `4968d60`.");
    expect(body).not.toContain("UTC");
  });

  it("renders no button and no checkbox — there is nothing to attest and nothing to re-check", () => {
    const body = renderComment(input);
    expect(body).not.toContain("- [ ]");
    expect(body).not.toContain("attest-button.svg");
  });

  // -------------------------------------------------------------------------
  // The record link
  //
  // Until the service grew `GET /r/:owner/:repo/:pr` there was nowhere to send
  // a reviewer: `/a/…` is the attest *form*, it 302s an anonymous visitor to
  // GitHub's OAuth authorize endpoint, and its "already attested" lookup binds
  // to the visitor's own login — so it shows everybody but the attestor a form
  // inviting them to attest somebody else's commit. These pin that this state
  // links the read-only page and not that one.
  // -------------------------------------------------------------------------

  it("links the read-only record page for this pull request", () => {
    expect(renderComment(input)).toContain("[View the record →](https://ackt.dev/r/opentdf/platform/3794)");
  });

  it("links the record page, never the attest form", () => {
    const body = renderComment(input);
    expect(body).not.toContain("/a/opentdf/platform");
  });

  it("builds the record URL from the service input, so a self-hosted deployment links to itself", () => {
    const body = renderComment({ ...input, service: "https://ackt.internal.example" });
    expect(body).toContain("[View the record →](https://ackt.internal.example/r/opentdf/platform/3794)");
    // The footer's attribution still names ackt.dev — that is the tool's name,
    // not the deployment's address (see `FOOTER`).
    expect(body).toContain(FOOTER_LINE);
  });

  it("percent-encodes owner and repo in the record URL", () => {
    const body = renderComment({ ...input, owner: "a b", repo: "c/d" });
    expect(body).toContain("https://ackt.dev/r/a%20b/c%2Fd/3794");
  });

  it("keeps the state's restraint: the link is plain markdown, not a second button", () => {
    const body = renderComment(input);
    expect(body).not.toContain("[![");
    // Sentence, blank line, link — the link is its own line, not tacked onto
    // the end of the sentence.
    const lines = body.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toContain("[View the record →](https://ackt.dev/r/opentdf/platform/3794)");
  });

  it("is the only state that links the record — the other two send you to attest instead", () => {
    for (const [name, state] of STATES) {
      if (name === "attested") continue;
      expect(renderComment(state), name).not.toContain("View the record");
    }
  });
});

describe("renderComment — stale", () => {
  const prior: readonly AttestationRecord[] = [
    { actor: "jrschumacher", headSha: "e0b3f72c1a4d9f0b5e6a7c8d9e0f1a2b3c4d5e6f", recordedAt: "2026-08-09 12:23" },
  ];
  const input: CommentInput = {
    ...BASE_INPUT,
    headSha: "91acd0400000000000000000000000000000000",
    attested: false,
    priorAttestations: prior,
  };

  it("names the commit the head moved to", () => {
    const body = renderComment(input);
    expect(body).toContain("The head moved to `91acd04`.");
  });

  it("offers a way to attest the new diff", () => {
    const body = renderComment(input);
    expect(body).toContain(`${BUTTON}(https://ackt.dev/a/opentdf/platform/3794/${input.headSha})`);
  });

  it("keeps the re-check checkbox, unchecked, under the button", () => {
    expect(renderComment(input)).toContain("- [ ] Re-check after attesting");
  });

  it("puts the prior attestation(s) inside a collapsed <details>, each marked superseded", () => {
    const body = renderComment(input);
    expect(body).toContain("<details>");
    expect(body).toContain("</details>");
    expect(body).toContain("<summary>Attestation history (1)</summary>");

    const start = body.indexOf("<details>");
    const end = body.indexOf("</details>");
    const detailsBlock = body.slice(start, end);
    expect(detailsBlock).toContain("e0b3f72");
    expect(detailsBlock).toContain("(superseded)");
    expect(detailsBlock).toContain("[@jrschumacher](https://github.com/jrschumacher)");
  });

  it("keeps the collapsed history — who attested what, and when, is the record this tool exists to keep", () => {
    const body = renderComment(input);
    expect(body.indexOf("<details>")).toBeGreaterThan(body.indexOf("- [ ]"));
    expect(body.indexOf("<details>")).toBeLessThan(body.indexOf("---\n" + FOOTER_LINE));
  });

  it("falls back to the awaiting render when priorAttestations is empty", () => {
    const body = renderComment({ ...BASE_INPUT, attested: false, priorAttestations: [] });
    expect(body).toContain("Nobody has attested `4968d60` yet.");
  });
});

describe("escapeMarkdown", () => {
  it("escapes pipes so they cannot break a table row", () => {
    expect(escapeMarkdown("a|b")).toBe("a\\|b");
  });

  it("escapes backticks so they cannot break out of a code span", () => {
    expect(escapeMarkdown("a`b")).toBe("a&#96;b");
  });

  it("escapes angle brackets so HTML cannot be injected", () => {
    expect(escapeMarkdown("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert\\(1\\)&gt;");
  });

  it("escapes ampersands first so introduced entities are not re-escaped", () => {
    expect(escapeMarkdown("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("escapes brackets and parens so markdown link syntax cannot be forged", () => {
    expect(escapeMarkdown("[click](javascript:alert(1))")).toBe("\\[click\\]\\(javascript:alert\\(1\\)\\)");
  });
});

describe("renderComment escaping of attacker-controlled fields", () => {
  // The branch name and PR title are no longer interpolated at all — the
  // context line that carried them is gone — so the two tests that used to
  // guard their escaping went with it. `escapeMarkdown` itself is still
  // covered above, and every remaining interpolation is exercised below.

  it("a malicious actor login is neutralized in the attested sentence and profile link", () => {
    const body = renderComment({
      ...BASE_INPUT,
      attested: true,
      recordedAt: "2026-08-09 12:23",
      actor: "evil](javascript:alert(1))<img src=x>",
    });
    expect(body).not.toContain("<img");
    expect(body).not.toContain("](javascript:alert(1))<img");
  });

  it("a malicious prior-attestation actor login is neutralized in the stale history table", () => {
    const body = renderComment({
      ...BASE_INPUT,
      attested: false,
      priorAttestations: [{ actor: "evil<script>", headSha: "a".repeat(40), recordedAt: "2026-08-09 12:23" }],
    });
    expect(body).not.toContain("<script>");
  });
});

describe("formatUtc", () => {
  it("formats a Date as 'YYYY-MM-DD HH:mm' in UTC", () => {
    expect(formatUtc(new Date(Date.UTC(2026, 7, 9, 12, 23, 45)))).toBe("2026-08-09 12:23");
  });

  it("zero-pads single-digit month, day, hour, and minute", () => {
    expect(formatUtc(new Date(Date.UTC(2026, 0, 5, 3, 7, 0)))).toBe("2026-01-05 03:07");
  });
});

describe("findAcktComment", () => {
  function comment(overrides: Partial<GithubComment>): GithubComment {
    return { id: 1, body: "", user: { login: BOT_LOGIN }, ...overrides };
  }

  it("finds the bot's comment by marker among others", () => {
    const comments: GithubComment[] = [
      comment({ id: 1, body: "unrelated comment", user: { login: "someone" } }),
      comment({ id: 2, body: `### Review attestation\n${ACKT_COMMENT_MARKER}` }),
      comment({ id: 3, body: "another unrelated comment", user: { login: "someone-else" } }),
    ];
    const found = findAcktComment(comments);
    expect(found?.id).toBe(2);
  });

  it("ignores a copy of the marker text posted by a non-bot user", () => {
    const comments: GithubComment[] = [comment({ id: 5, body: `pretending ${ACKT_COMMENT_MARKER}`, user: { login: "attacker" } })];
    expect(findAcktComment(comments)).toBeNull();
  });

  it("returns null when there is no ackt comment", () => {
    const comments: GithubComment[] = [comment({ id: 1, body: "hello" }), comment({ id: 2, body: "world", user: { login: "someone" } })];
    expect(findAcktComment(comments)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(findAcktComment([])).toBeNull();
  });
});

describe("isCheckboxChecked", () => {
  it("detects the label that renderComment actually ships — the pairing that makes the re-trigger work", () => {
    // The single most breakable link in the feature: `trigger.ts` acts on an
    // `issue_comment edited` whose box went from unchecked to checked, and
    // this is what "checked" means. A label the detector doesn't recognise
    // kills the re-trigger silently, with nothing anywhere to notice.
    const rendered = renderComment(BASE_INPUT);
    expect(isCheckboxChecked(rendered)).toBe(false);
    expect(isCheckboxChecked(rendered.replace("- [ ]", "- [x]"))).toBe(true);
  });

  it("is false for an unchecked box", () => {
    expect(isCheckboxChecked("- [ ] Re-check after attesting")).toBe(false);
  });

  it("is true for a checked box", () => {
    expect(isCheckboxChecked("- [x] Re-check after attesting")).toBe(true);
  });

  it("is true for an uppercase checked box", () => {
    expect(isCheckboxChecked("- [X] Re-check after attesting")).toBe(true);
  });

  it("still recognises the previous label, so a comment already on a PR keeps working", () => {
    expect(isCheckboxChecked("- [x] Re-check attestation")).toBe(true);
    expect(isCheckboxChecked("- [ ] Re-check attestation")).toBe(false);
  });

  it("is false when the checkbox is absent", () => {
    expect(isCheckboxChecked("no checkbox here at all")).toBe(false);
  });

  it("is false for the attested render, which ships no checkbox at all", () => {
    expect(isCheckboxChecked(renderComment({ ...BASE_INPUT, attested: true, recordedAt: "2026-08-09 12:23" }))).toBe(false);
  });
});

describe("resetCheckbox", () => {
  it("resets a checked box to unchecked", () => {
    expect(resetCheckbox("before\n- [x] Re-check after attesting\nafter")).toBe("before\n- [ ] Re-check after attesting\nafter");
  });

  it("resets an uppercase checked box to unchecked", () => {
    expect(resetCheckbox("- [X] Re-check after attesting")).toBe("- [ ] Re-check after attesting");
  });

  it("rewrites the previous label to the current one, migrating a comment already on a PR", () => {
    expect(resetCheckbox("- [x] Re-check attestation")).toBe("- [ ] Re-check after attesting");
  });

  it("is idempotent on an already-unchecked box", () => {
    const once = resetCheckbox("- [ ] Re-check after attesting");
    expect(resetCheckbox(once)).toBe(once);
  });

  it("is idempotent applied twice to a checked box", () => {
    const once = resetCheckbox("- [x] Re-check after attesting");
    const twice = resetCheckbox(once);
    expect(twice).toBe(once);
  });

  it("leaves a body with no checkbox unchanged", () => {
    expect(resetCheckbox("nothing to see here")).toBe("nothing to see here");
  });

  it("round-trips a rendered comment: reset leaves it byte-identical, marker included", () => {
    // `index.ts` pipes every render through `resetCheckbox` before posting.
    // If that ever mangled the body, the marker could stop matching and the
    // Action would post a new comment on every run instead of editing its own.
    for (const [, input] of STATES) {
      const rendered = renderComment(input);
      expect(resetCheckbox(rendered)).toBe(rendered);
      expect(resetCheckbox(rendered)).toContain(ACKT_COMMENT_MARKER);
      expect(findAcktComment([{ id: 1, body: resetCheckbox(rendered), user: { login: BOT_LOGIN } }])?.id).toBe(1);
    }
  });
});
