/**
 * Pure rendering and parsing for the ackt PR comment (SPEC §4.9, adapted for
 * the no-App design — see docs/superpowers/specs/2026-08-08-no-app-design.md
 * — where the Action posts this comment directly with the workflow
 * `GITHUB_TOKEN` instead of a GitHub App).
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
 * Escapes a value before it is interpolated into the comment. Branch names
 * and PR titles are attacker-controlled — anyone who can open a pull request
 * controls both — so a branch named `a|b` must not break the markdown table,
 * and a title containing `<img src=x onerror=...>` must not render as
 * markup. Order matters: `&` first, so the entities this function itself
 * introduces don't get re-escaped.
 */
export function escapeMarkdown(input) {
    return input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/`/g, "&#96;")
        .replace(/\|/g, "\\|");
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
/**
 * SPEC §4.9's comment, re-rendered and updated in place on every run rather
 * than appended to — there is no per-verification history row because there
 * is no App posting one (docs/superpowers/specs/2026-08-08-no-app-design.md).
 * Always contains `ACKT_COMMENT_MARKER`, and always renders the checkbox
 * unchecked: re-rendering from scratch is what makes "reset the checkbox" a
 * side effect of normal operation rather than a separate step that could be
 * forgotten (`resetCheckbox`, below, exists for the same reason expressed as
 * an explicit, independently testable operation).
 */
export function renderComment(input) {
    const url = attestUrl(input.service, input.owner, input.repo, input.pr, input.headSha);
    const headShort = input.headSha.slice(0, 7);
    const title = escapeMarkdown(input.title);
    const branch = escapeMarkdown(input.headRef);
    const status = input.attested
        ? `✅ Attested by @${input.actor} at \`${headShort}\``
        : `⏳ Not yet attested at \`${headShort}\` — @${input.actor}, please attest`;
    const lines = [
        "### Review attestation",
        "",
        `Author: [attest that you read this diff](${url})`,
        "",
        "| Field | Value |",
        "|---|---|",
        `| Pull request | ${title} (\`${branch}\`) |`,
        `| Status | ${status} |`,
    ];
    if (input.attested && input.statementSha256 !== undefined) {
        lines.push(`| Statement | \`${input.statementSha256.slice(0, 12)}\` |`);
    }
    lines.push("", `- [ ] ${CHECKBOX_LABEL}`, "", "_Toggling the box above re-checks attestation. Commenting `/ackt` on its own line does the same thing._", "", ACKT_COMMENT_MARKER);
    return lines.join("\n");
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
 */
export function isCheckboxChecked(body) {
    const match = CHECKBOX_RE.exec(body);
    if (match === null)
        return false;
    return match[1]?.toLowerCase() === "x";
}
/** Idempotent: running this on an already-unchecked body returns the same body. */
export function resetCheckbox(body) {
    return body.replace(CHECKBOX_RE, `- [ ] ${CHECKBOX_LABEL}`);
}
