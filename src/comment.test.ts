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
  headRef: "feature/foo",
  title: "Add foo",
  attested: false,
};

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

describe("renderComment — awaiting", () => {
  it("renders the awaiting heading and names the current commit", () => {
    const body = renderComment(BASE_INPUT);
    expect(body).toContain("Human review attestation — awaiting");
    expect(body).toContain("`4968d60`");
  });

  it("renders a prominent attest link/CTA for the current head", () => {
    const body = renderComment(BASE_INPUT);
    expect(body).toContain(`[Attest to this diff](https://ackt.dev/a/opentdf/platform/3794/${BASE_INPUT.headSha})`);
  });

  it("notes that commenting /ackt re-runs the check", () => {
    expect(renderComment(BASE_INPUT)).toMatch(/\/ackt/);
  });

  it("keeps the re-check checkbox, unchecked, next to the CTA", () => {
    expect(renderComment(BASE_INPUT)).toContain("- [ ] Re-check attestation");
  });
});

describe("renderComment — attested", () => {
  const input: CommentInput = { ...BASE_INPUT, attested: true, recordedAt: "2026-08-09 12:23" };

  it("renders the attested heading", () => {
    expect(renderComment(input)).toContain("Human review attestation — ✔ attested");
  });

  it("renders a table with Author / Commit / Recorded (UTC) columns", () => {
    const body = renderComment(input);
    expect(body).toContain("| Author | Commit | Recorded (UTC) |");
    expect(body).toContain("[@jrschumacher](https://github.com/jrschumacher)");
    expect(body).toContain("`4968d60`");
    expect(body).toContain("2026-08-09 12:23");
  });

  it("states the attestation covers exactly this commit and that new commits reset it", () => {
    expect(renderComment(input)).toMatch(/Covers exactly `4968d60`\. New commits reset the check\./);
  });

  it("does not render the re-check checkbox — there is nothing to re-check yet", () => {
    expect(renderComment(input)).not.toContain("- [ ] Re-check attestation");
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

  it("renders the stale heading and names the new/current commit", () => {
    const body = renderComment(input);
    expect(body).toContain("Human review attestation — ⚠ stale");
    expect(body).toContain("`91acd04`");
  });

  it("offers a way to attest the new diff", () => {
    const body = renderComment(input);
    expect(body).toContain(`[Attest to the new diff](https://ackt.dev/a/opentdf/platform/3794/${input.headSha})`);
  });

  it("keeps the re-check checkbox, unchecked, next to the re-attest prompt", () => {
    expect(renderComment(input)).toContain("- [ ] Re-check attestation");
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

  it("falls back to the awaiting render when priorAttestations is empty", () => {
    const body = renderComment({ ...BASE_INPUT, attested: false, priorAttestations: [] });
    expect(body).toContain("Human review attestation — awaiting");
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
  it("a malicious branch name is neutralized in the context line", () => {
    const body = renderComment({ ...BASE_INPUT, headRef: "evil|`<script>alert(1)</script>`" });
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("`<script>");
    expect(body).toContain("evil\\|&#96;&lt;script&gt;alert\\(1\\)&lt;/script&gt;&#96;");
  });

  it("a malicious PR title is neutralized in the context line", () => {
    const body = renderComment({ ...BASE_INPUT, title: "Fix | bug `here` <b>now</b>" });
    expect(body).not.toContain("<b>");
    expect(body).not.toContain("</b>");
    expect(body).toContain("Fix \\| bug &#96;here&#96; &lt;b&gt;now&lt;/b&gt;");
  });

  it("a malicious actor login is neutralized in the attested table row and profile link", () => {
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
  it("is false for an unchecked box", () => {
    expect(isCheckboxChecked("- [ ] Re-check attestation")).toBe(false);
  });

  it("is true for a checked box", () => {
    expect(isCheckboxChecked("- [x] Re-check attestation")).toBe(true);
  });

  it("is true for an uppercase checked box", () => {
    expect(isCheckboxChecked("- [X] Re-check attestation")).toBe(true);
  });

  it("is false when the checkbox is absent", () => {
    expect(isCheckboxChecked("no checkbox here at all")).toBe(false);
  });
});

describe("resetCheckbox", () => {
  it("resets a checked box to unchecked", () => {
    expect(resetCheckbox("before\n- [x] Re-check attestation\nafter")).toBe("before\n- [ ] Re-check attestation\nafter");
  });

  it("resets an uppercase checked box to unchecked", () => {
    expect(resetCheckbox("- [X] Re-check attestation")).toBe("- [ ] Re-check attestation");
  });

  it("is idempotent on an already-unchecked box", () => {
    const once = resetCheckbox("- [ ] Re-check attestation");
    expect(resetCheckbox(once)).toBe(once);
  });

  it("is idempotent applied twice to a checked box", () => {
    const once = resetCheckbox("- [x] Re-check attestation");
    const twice = resetCheckbox(once);
    expect(twice).toBe(once);
  });

  it("leaves a body with no checkbox unchanged", () => {
    expect(resetCheckbox("nothing to see here")).toBe("nothing to see here");
  });
});
