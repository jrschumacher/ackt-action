/**
 * Pure rendering and parsing for the ackt PR comment (SPEC §4.9, adapted for
 * the no-App design — see docs/superpowers/specs/2026-08-08-no-app-design.md
 * — where the Action posts this comment directly with the workflow
 * `GITHUB_TOKEN` instead of a GitHub App).
 *
 * Three states, matching the design system's GitHub-comment mockups
 * (ackt-system.dc.html §3d, "GitHub comment"):
 *
 *  - "awaiting": nobody has attested at the current head yet.
 *  - "attested": the PR author attested exactly the current head.
 *  - "stale": the head moved since the last attestation; the prior
 *    attestation(s) are shown, collapsed, each marked superseded.
 *
 * `renderComment` derives the state from `CommentInput` rather than taking
 * an explicit `state` field: `attested` is already the fact the rest of the
 * Action knows, and `priorAttestations` is only ever non-empty when the
 * caller has something stale to show — so the state is a derived property,
 * not a second source of truth that could disagree with the data driving it.
 *
 * The design's mockups show a custom `ackt[bot]` avatar and display name —
 * that requires a GitHub App this project deliberately does not have, so
 * only the comment *content* below follows the design; the bot identity
 * stays the workflow's own `github-actions[bot]` (see `BOT_LOGIN`).
 *
 * Nothing here touches the network: it only builds and reads markdown
 * strings, which is what makes it fully unit-testable without mocking
 * anything.
 */

/**
 * Trailing marker identifying the ackt comment (SPEC §4.9). Identification
 * only — it carries no state, so nothing can be forged by reproducing it.
 */
export const ACKT_COMMENT_MARKER = "<!-- ackt:comment v=1 -->";

/**
 * The login the comment must be authored by, and the same login trigger.ts
 * refuses to react to — see that module's self-trigger guard.
 */
export const BOT_LOGIN = "github-actions[bot]";

const CHECKBOX_LABEL = "Re-check attestation";
const CHECKBOX_RE = new RegExp(`-\\s*\\[([ xX])\\]\\s*${CHECKBOX_LABEL}`);
/**
 * The design (ackt-system.dc.html §3d) has no checkbox — it only mentions
 * `/ackt` as a slash-command re-trigger. The checkbox is kept anyway: it's a
 * deliberate product decision (one click, no typing required) that predates
 * and survives this redesign. See `renderAwaiting`/`renderStale` for where
 * it's folded into each state's layout, and the module-level report for why
 * `renderAttested` omits it.
 */
const CHECKBOX_LINE = `- [ ] ${CHECKBOX_LABEL}`;

export interface GithubComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly login: string };
}

/** One prior attestation, rendered superseded inside the "stale" state's collapsed history. */
export interface AttestationRecord {
  readonly actor: string;
  readonly headSha: string;
  readonly recordedAt: string;
}

export interface CommentInput {
  readonly service: string;
  readonly owner: string;
  readonly repo: string;
  readonly pr: number;
  readonly actor: string;
  readonly headSha: string;
  readonly headRef: string;
  readonly title: string;
  readonly attested: boolean;
  readonly statementSha256?: string;
  /** When `attested` is true: when the current head's attestation was recorded (UTC, `formatUtc` shape). */
  readonly recordedAt?: string;
  /**
   * Attestation(s) that covered an earlier head, now superseded by
   * `headSha`. A non-empty array here (with `attested: false`) is what
   * selects the "stale" render over plain "awaiting" — see the module doc
   * comment.
   */
  readonly priorAttestations?: readonly AttestationRecord[];
}

/**
 * Escapes a value before it is interpolated into the comment. Branch names,
 * PR titles, and actor logins are attacker-controlled — anyone who can open
 * a pull request controls all three — so a branch named `a|b` must not
 * break a markdown table, a title containing `<img src=x onerror=...>` must
 * not render as markup, and an actor login (used inside `[@login](url)`
 * profile links) must not be able to close the link label early with a
 * stray `]` or smuggle a fake `(url)` after it with `(`/`)`. Order matters:
 * `&` first, so the entities this function itself introduces don't get
 * re-escaped.
 */
export function escapeMarkdown(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * The Action always knows the head at comment-render time — it's the PR's
 * current head SHA, resolved from the API (see index.ts) — so the link
 * carries it directly instead of asking a human to copy it by hand. Exported
 * so index.ts can build the same link shape for the status check's
 * `target_url` without duplicating it.
 */
export function attestUrl(service: string, owner: string, repo: string, pr: number, head: string): string {
  return `${service}/a/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pr}/${head}`;
}

/** Formats a Date as `YYYY-MM-DD HH:mm` UTC — the "Recorded (UTC)" column shape from the design. */
export function formatUtc(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** A GitHub profile link for an (escaped) actor login — used anywhere an author appears in a table cell. */
function profileLink(actor: string): string {
  return `[@${escapeMarkdown(actor)}](https://github.com/${encodeURIComponent(actor)})`;
}

/**
 * Identifies which PR/branch this comment belongs to. Kept to one `<sub>`
 * line rather than a table row — the comment already lives on the PR it
 * describes, and the "keep it short" constraint rules out spending a whole
 * table row on redundant context.
 */
function contextLine(input: CommentInput): string {
  return `<sub>${escapeMarkdown(input.title)} (\`${escapeMarkdown(input.headRef)}\`)</sub>`;
}

function renderAwaiting(input: CommentInput, url: string, headShort: string): string[] {
  return [
    "### Human review attestation — awaiting",
    "",
    contextLine(input),
    "",
    `No one has attested to reading this diff at \`${headShort}\` yet.`,
    "",
    `**[Attest to this diff](${url})**`,
    "",
    // Checkbox placement: directly under the CTA it duplicates, so both
    // re-trigger paths (click the box, or comment /ackt) sit together.
    CHECKBOX_LINE,
    "",
    "_After attesting, comment `/ackt` — or check the box above — to re-run the check. The attestation covers exactly this commit._",
  ];
}

function renderAttested(input: CommentInput, headShort: string): string[] {
  const recordedAt = input.recordedAt !== undefined ? escapeMarkdown(input.recordedAt) : "";
  return [
    "### Human review attestation — ✔ attested",
    "",
    contextLine(input),
    "",
    "| Author | Commit | Recorded (UTC) |",
    "|---|---|---|",
    `| ${profileLink(input.actor)} | \`${headShort}\` | ${recordedAt} |`,
    "",
    // No checkbox here, unlike the other two states: there is nothing to
    // re-check until a new commit lands, at which point this state isn't
    // rendered anymore anyway (the next run sees a different head and
    // renders "awaiting"/"stale" instead).
    `_Covers exactly \`${headShort}\`. New commits reset the check._`,
  ];
}

function renderStale(input: CommentInput, url: string, headShort: string): string[] {
  const prior = input.priorAttestations ?? [];
  return [
    "### Human review attestation — ⚠ stale",
    "",
    contextLine(input),
    "",
    `The head moved to \`${headShort}\`. Earlier attestations below cover commits this PR no longer points at.`,
    "",
    `**[Attest to the new diff](${url})**`,
    "",
    // Checkbox placement: same reasoning as "awaiting" — right next to the
    // re-attest prompt, so the one-click path sits next to the CTA it
    // duplicates rather than buried after the collapsed history below.
    CHECKBOX_LINE,
    "",
    "_Comment `/ackt` — or check the box above — to attest the new diff._",
    "",
    "<details>",
    `<summary>Attestation history (${prior.length})</summary>`,
    "",
    "| Author | Commit | Recorded (UTC) |",
    "|---|---|---|",
    ...prior.map((a) => `| ${profileLink(a.actor)} | \`${a.headSha.slice(0, 7)}\` <em>(superseded)</em> | ${escapeMarkdown(a.recordedAt)} |`),
    "",
    "</details>",
  ];
}

/**
 * SPEC §4.9's comment, re-rendered and updated in place on every run rather
 * than appended to — there is no per-verification history row because there
 * is no App posting one (docs/superpowers/specs/2026-08-08-no-app-design.md).
 *
 * Picks one of three renders (see module doc comment): `attested` wins if
 * true; otherwise a non-empty `priorAttestations` means "stale"; otherwise
 * "awaiting". Always contains `ACKT_COMMENT_MARKER`.
 */
export function renderComment(input: CommentInput): string {
  const url = attestUrl(input.service, input.owner, input.repo, input.pr, input.headSha);
  const headShort = input.headSha.slice(0, 7);

  const body = input.attested
    ? renderAttested(input, headShort)
    : (input.priorAttestations?.length ?? 0) > 0
      ? renderStale(input, url, headShort)
      : renderAwaiting(input, url, headShort);

  return [...body, "", ACKT_COMMENT_MARKER].join("\n");
}

/**
 * SPEC §4.9: found by marker among the bot's own comments. Both conditions
 * matter — content and authorship — because a participant could paste a copy
 * of the marker into their own comment; `findAcktComment` must ignore that
 * (see SPEC §4.9: "a reader cannot distinguish an App-authored comment from
 * a participant's copy of the same text by content alone").
 */
export function findAcktComment(comments: readonly GithubComment[]): GithubComment | null {
  for (const comment of comments) {
    if (comment.user.login === BOT_LOGIN && comment.body.includes(ACKT_COMMENT_MARKER)) {
      return comment;
    }
  }
  return null;
}

/**
 * An absent checkbox (no match at all) counts as unchecked, not an error —
 * a hand-edited body with the checkbox line deleted should not crash a run.
 * This also covers the "attested" render, which has no checkbox at all.
 */
export function isCheckboxChecked(body: string): boolean {
  const match = CHECKBOX_RE.exec(body);
  if (match === null) return false;
  return match[1]?.toLowerCase() === "x";
}

/** Idempotent: running this on an already-unchecked body, or a body with no checkbox at all, returns the same body. */
export function resetCheckbox(body: string): string {
  return body.replace(CHECKBOX_RE, CHECKBOX_LINE);
}
