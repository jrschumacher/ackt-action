import { describe, expect, it } from "vitest";

import {
  ACKT_COMMENT_MARKER,
  BOT_LOGIN,
  escapeMarkdown,
  findAcktComment,
  isCheckboxChecked,
  renderComment,
  resetCheckbox,
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
  it("always contains the marker", () => {
    expect(renderComment(BASE_INPUT)).toContain(ACKT_COMMENT_MARKER);
    expect(renderComment({ ...BASE_INPUT, attested: true, statementSha256: "9f86d081884c7d65" })).toContain(ACKT_COMMENT_MARKER);
  });

  it("contains the attest link with owner/repo/pr/head", () => {
    const body = renderComment(BASE_INPUT);
    expect(body).toContain("https://ackt.dev/a/opentdf/platform/3794/4968d60a36f23ca29993221a36828213fe43b304");
  });

  it("updates the link's head segment when the head changes — the whole point of carrying it here", () => {
    const newHead = "9999999999999999999999999999999999999999";
    const body = renderComment({ ...BASE_INPUT, headSha: newHead });
    expect(body).toContain(`https://ackt.dev/a/opentdf/platform/3794/${newHead}`);
    expect(body).not.toContain(BASE_INPUT.headSha);
  });

  it("renders the unchecked re-check checkbox", () => {
    expect(renderComment(BASE_INPUT)).toContain("- [ ] Re-check attestation");
  });

  it("notes that /ackt also works", () => {
    expect(renderComment(BASE_INPUT)).toMatch(/\/ackt/);
  });

  it("renders attested vs not-attested status distinctly", () => {
    const notAttested = renderComment(BASE_INPUT);
    const attested = renderComment({ ...BASE_INPUT, attested: true });
    expect(notAttested).toContain("Not yet attested");
    expect(attested).toContain("Attested by @jrschumacher");
  });

  it("is stable — identical input produces identical output", () => {
    expect(renderComment(BASE_INPUT)).toBe(renderComment(BASE_INPUT));
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
    expect(escapeMarkdown("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes ampersands first so introduced entities are not re-escaped", () => {
    expect(escapeMarkdown("a & b < c")).toBe("a &amp; b &lt; c");
  });
});

/** Real table delimiters only — a `\|` produced by escapeMarkdown is a literal escaped pipe, not a cell boundary, so it's stripped before counting. */
function countUnescapedPipes(line: string): number {
  return line.replace(/\\\|/g, "").split("|").length - 1;
}

describe("renderComment escaping of attacker-controlled fields", () => {
  it("a malicious branch name does not break the table or inject markup", () => {
    const body = renderComment({ ...BASE_INPUT, headRef: "evil|`<script>alert(1)</script>`" });
    // The table row must still have exactly 3 real (unescaped) pipe
    // delimiters — the malicious value's own `|` must have been escaped,
    // not left free to open an extra cell.
    const row = body.split("\n").find((line) => line.startsWith("| Pull request"));
    expect(row).toBeDefined();
    expect(countUnescapedPipes(row ?? "")).toBe(3);
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("`<script>");
  });

  it("a malicious PR title does not break the table or inject markup", () => {
    const body = renderComment({ ...BASE_INPUT, title: "Fix | bug `here` <b>now</b>" });
    expect(body).not.toContain("<b>");
    expect(body).not.toContain("</b>");
    const row = body.split("\n").find((line) => line.startsWith("| Pull request"));
    expect(row).toBeDefined();
    expect(countUnescapedPipes(row ?? "")).toBe(3);
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
