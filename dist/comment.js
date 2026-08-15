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
 * All three share one heading, one green "Attest this PR" button (a linked
 * image served by the same service that records the attestation — see
 * `attestButton`), and one footer, and each carries only what its own state
 * genuinely adds: a sentence naming the commit, the checkbox, and — for
 * "stale" alone — the collapsed history of superseded attestations.
 *
 * What each state deliberately no longer carries, since a shorter comment
 * that says less is the point rather than a side effect:
 *
 *  - The `<sub>` context line repeating the PR title and branch. GitHub
 *    already renders both directly above the comment.
 *  - The two-sentence italic footnote explaining `/ackt` *and* the checkbox.
 *    `/ackt` still works — trigger.ts is untouched — it is simply no longer
 *    advertised, because the box is one click and needs no explaining.
 *  - "The attestation covers exactly this commit." Naming the short SHA in
 *    the sentence above it already says that.
 *  - The ✔/⚠ state suffix on the heading; see `HEADING`.
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
const CHECKBOX_LABEL = "Re-check after attesting";
/**
 * Deliberately looser than `CHECKBOX_LINE`: it matches any `Re-check …` label
 * to the end of the line, not this exact wording. Comments already posted by
 * an earlier version of the Action say "Re-check attestation", and a reader
 * who ticks one of those boxes must still trigger a run — a label change that
 * the detector doesn't recognise silently kills the re-trigger, with no error
 * anywhere to notice. The same looseness lets `resetCheckbox` rewrite an old
 * label to the current one in place, so an old comment migrates the first time
 * it is updated.
 */
const CHECKBOX_RE = /-[ \t]*\[([ xX])\][ \t]*Re-check[^\n]*/;
/**
 * The design (ackt-system.dc.html §3d) has no checkbox — it only mentions
 * `/ackt` as a slash-command re-trigger. The checkbox is kept anyway: it's a
 * deliberate product decision (one click, no typing required) that predates
 * and survives this redesign. It is now the *only* advertised re-trigger
 * path: `/ackt` still works (trigger.ts is unchanged) but explaining both
 * paths cost two sentences of italic footnote to save one click, which is
 * what made the old comment read as verbose. See `renderAwaiting`/
 * `renderStale` for where it sits, and `renderAttested` for why that state
 * has no box at all.
 */
const CHECKBOX_LINE = `- [ ] ${CHECKBOX_LABEL}`;
/**
 * The button, as a linked image — a GitHub comment is markdown, so that is
 * what a button is there. Three things are load-bearing:
 *
 *  - **The alt text is the call to action.** If camo is down, the reader
 *    blocks images, or a screen reader is reading the comment, `Attest this
 *    PR` is all that is left — and it degrades to a working text link rather
 *    than a broken-image icon. It matches the label drawn in the asset.
 *  - **The asset comes from the same service the attestation does.** A
 *    self-hosted deployment serves its own button, exactly as it serves its
 *    own `/a/…` links; nothing here points at ackt.dev by name.
 *  - **Verified, not assumed.** GitHub proxies external images through camo,
 *    and camo serving SVG was checked against a live PR rather than
 *    remembered. See the service's `attestButtonSvg()` for the rest.
 */
function attestButton(service, url) {
    return `[![Attest this PR](${service}/attest-button.svg)](${url})`;
}
/**
 * Shared by all three states. Attribution for the tool, so it names ackt
 * whatever service produced the attestation — unlike `attestButton`'s asset
 * and `attestUrl`'s link, which follow the configured deployment.
 *
 * The `---` needs the blank line above it that `renderComment` supplies, or
 * markdown reads it as a setext underline and turns the preceding paragraph
 * into a heading.
 */
const FOOTER = ["---", "powered by [ackt.dev](https://ackt.dev)"];
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
export function escapeMarkdown(input) {
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
export function attestUrl(service, owner, repo, pr, head) {
    return `${service}/a/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pr}/${head}`;
}
/** Formats a Date as `YYYY-MM-DD HH:mm` UTC — the "Recorded (UTC)" column shape from the design. */
export function formatUtc(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
/** A GitHub profile link for an (escaped) actor login — used anywhere an author appears in a table cell. */
function profileLink(actor) {
    return `[@${escapeMarkdown(actor)}](https://github.com/${encodeURIComponent(actor)})`;
}
/**
 * The same heading in all three states, with no state suffix and no ✔/⚠ glyph.
 *
 * Two reasons the state left the heading. GitHub already publishes this
 * comment's verdict as a commit status (index.ts posts one, with the same
 * `attestUrl` as its `target_url`) — the pass/fail signal a reader scans for
 * lives in the checks panel, and repeating it in the heading was the comment
 * competing with a surface that does it better. And each state's first line
 * of body now says the fact in words, which a screen reader and a plaintext
 * client both read correctly; `— ✔ attested` does not.
 */
const HEADING = "### Human review attestation";
function renderAwaiting(input, url, headShort) {
    return [
        HEADING,
        "",
        attestButton(input.service, url),
        "",
        // The short SHA does the work the deleted "covers exactly this commit"
        // sentence used to: naming the commit *is* the scope claim.
        `Nobody has attested \`${headShort}\` yet.`,
        "",
        CHECKBOX_LINE,
    ];
}
function renderAttested(input, headShort) {
    const recordedAt = input.recordedAt !== undefined ? escapeMarkdown(input.recordedAt) : "";
    const when = recordedAt === "" ? "" : ` on ${recordedAt} UTC`;
    return [
        HEADING,
        "",
        // A one-row table is heavier than the sentence it holds; the "stale"
        // state keeps its table because it has a list to tabulate. Nothing here
        // claims the diff was any *good* — only that a person read it at this
        // commit, which is the whole of what was proven.
        `${profileLink(input.actor)} attested \`${headShort}\`${when}.`,
        // No button and no checkbox: there is nothing to attest and nothing to
        // re-check until a new commit lands, at which point this state isn't
        // rendered anymore anyway (the next run sees a different head and
        // renders "awaiting"/"stale" instead).
    ];
}
function renderStale(input, url, headShort) {
    const prior = input.priorAttestations ?? [];
    return [
        HEADING,
        "",
        attestButton(input.service, url),
        "",
        `The head moved to \`${headShort}\`. Earlier attestations cover commits this PR no longer points at.`,
        "",
        CHECKBOX_LINE,
        "",
        // Kept, collapsed: who attested what, and when, is real information —
        // it is the record this whole tool exists to keep. Only the prose around
        // it was redundant.
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
export function renderComment(input) {
    const url = attestUrl(input.service, input.owner, input.repo, input.pr, input.headSha);
    const headShort = input.headSha.slice(0, 7);
    const body = input.attested
        ? renderAttested(input, headShort)
        : (input.priorAttestations?.length ?? 0) > 0
            ? renderStale(input, url, headShort)
            : renderAwaiting(input, url, headShort);
    return [...body, "", ...FOOTER, "", ACKT_COMMENT_MARKER].join("\n");
}
/**
 * SPEC §4.9: found by marker among the bot's own comments. Both conditions
 * matter — content and authorship — because a participant could paste a copy
 * of the marker into their own comment; `findAcktComment` must ignore that
 * (see SPEC §4.9: "a reader cannot distinguish an App-authored comment from
 * a participant's copy of the same text by content alone").
 */
export function findAcktComment(comments) {
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
export function isCheckboxChecked(body) {
    const match = CHECKBOX_RE.exec(body);
    if (match === null)
        return false;
    return match[1]?.toLowerCase() === "x";
}
/** Idempotent: running this on an already-unchecked body, or a body with no checkbox at all, returns the same body. */
export function resetCheckbox(body) {
    return body.replace(CHECKBOX_RE, CHECKBOX_LINE);
}
