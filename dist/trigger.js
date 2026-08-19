/**
 * Pure trigger decision for the ackt Action
 * (docs/superpowers/specs/2026-08-08-no-app-design.md, "Re-triggering").
 *
 * Two event types drive this, mixed with a lot of noise:
 *
 *  - `pull_request` fires for many actions; only opened/reopened/synchronize
 *    are ours.
 *  - `issue_comment` fires for every comment on every issue AND pull request
 *    in the repo, created or edited — almost none of them ackt's concern.
 *
 * Nothing here touches the network or the filesystem; every decision is a
 * pure function of the event name and payload, which is what makes the
 * whole matrix testable without a single mock. `isForkPullRequest` is here
 * for that reason too — it is a second question about the same payload, and
 * index.ts (the untestable shell) should be reading answers, not deriving
 * them.
 */
import { isCheckboxChecked } from "./comment.js";
/** Also the login `comment.ts` requires the ackt comment be authored by. */
export const BOT_LOGIN = "github-actions[bot]";
const PULL_REQUEST_TRIGGER_ACTIONS = new Set(["opened", "reopened", "synchronize"]);
/**
 * `/ackt` must start a line (leading whitespace tolerated) to count.
 * Decided, not incidental: "please run /ackt on this" or "see the /ackt
 * setup docs" are plausible sentences in a PR thread, and neither should
 * silently kick off a job. A command occupying its own line is the same
 * convention other chat-ops bots (`/lgtm`, `/retest`) use on GitHub.
 */
const ACKT_COMMAND_RE = /^\s*\/ackt\b/m;
/**
 * Whether this event is a `pull_request` whose head lives in a *different*
 * repository than its base — i.e. an outside contribution.
 *
 * Exists for one reason: GitHub refuses to issue an Actions OIDC token on a
 * fork-origin `pull_request`, whatever `permissions:` the workflow declares
 * (see oidc.ts's `FORK_DEGRADED_MESSAGE`). Without this, the Action failed
 * that run red and told the maintainer to add a permission that was already
 * there — on the exact scenario ackt exists for, a public repository taking
 * outside contributions.
 *
 * Decided by comparing head and base repository names in the payload rather
 * than by reading `GITHUB_REPOSITORY` or `pull_request.head.repo.fork`: the
 * comparison is what actually matters (a fork's own internal PR is not a
 * fork-origin run and does get a token), and it keeps this a pure function of
 * the event, testable with no environment at all.
 *
 * `issue_comment` is deliberately never a fork run: that event executes in
 * the base repository's context with the base repository's permissions, and
 * mints a token normally even when the PR came from a fork.
 *
 * A deleted or otherwise absent head repository counts as a fork — it is
 * certainly not the base repository, and the fallback that follows (a
 * degraded, unrecorded run) is the safe direction for a case we cannot read.
 */
export function isForkPullRequest(eventName, payload) {
    if (eventName !== "pull_request")
        return false;
    const pr = payload?.pull_request;
    if (pr === undefined)
        return false;
    const headRepo = pr.head?.repo?.full_name;
    const baseRepo = pr.base?.repo?.full_name;
    if (typeof baseRepo !== "string" || baseRepo.length === 0)
        return false; // can't tell; treat as same-repo and fail loudly as before
    return headRepo !== baseRepo;
}
export function decideTrigger(eventName, payload) {
    if (eventName === "pull_request") {
        return decidePullRequest(payload);
    }
    if (eventName === "issue_comment") {
        return decideIssueComment(payload);
    }
    return { act: false, reason: `event '${eventName}' is not handled by ackt` };
}
function decidePullRequest(payload) {
    if (PULL_REQUEST_TRIGGER_ACTIONS.has(payload.action)) {
        return { act: true, reason: `pull_request '${payload.action}'` };
    }
    return { act: false, reason: `pull_request action '${payload.action}' is not a trigger` };
}
function decideIssueComment(payload) {
    // The event fires for issues too — guard first. `issue.pull_request` is
    // present (an object) only when the "issue" is actually a pull request.
    if (payload.issue.pull_request === undefined) {
        return { act: false, reason: "comment is on an issue, not a pull request" };
    }
    // The Action edits its own comment to reset the checkbox after handling a
    // trigger, which fires `issue_comment: edited` again. Without a guard that
    // is an infinite loop. But "who authored the comment" and "who performed
    // this event" are different questions, and only the second one tells the
    // two `edited` cases apart:
    //   - the bot resets its own checkbox (must NOT re-trigger)
    //   - a human ticks the checkbox on the bot's own comment (MUST trigger —
    //     this is the whole point of the checkbox, and the comment is always
    //     bot-authored by design, so keying on the author here would refuse
    //     every human click)
    // `comment.user.login` (the author) only distinguishes the two cases on
    // `created`, where the bot's own initial post mentions "/ackt" in its body
    // and must not self-trigger. On `edited`, key on `sender` (the account
    // that performed the edit) instead. A missing `sender` fails closed
    // (refuse) rather than open, since this is a loop-capable path.
    if (payload.action === "created") {
        if (payload.comment.user.login === BOT_LOGIN) {
            return { act: false, reason: "comment is from the bot itself — refusing to self-trigger" };
        }
        if (ACKT_COMMAND_RE.test(payload.comment.body)) {
            return { act: true, reason: "issue_comment created with /ackt" };
        }
        return { act: false, reason: "new comment does not contain /ackt at the start of a line" };
    }
    if (payload.action === "edited") {
        const senderLogin = payload.sender?.login;
        if (senderLogin === undefined || senderLogin === BOT_LOGIN) {
            return {
                act: false,
                reason: senderLogin === undefined
                    ? "edited comment has no sender — refusing to self-trigger (fail closed)"
                    : "comment was edited by the bot itself — refusing to self-trigger",
            };
        }
        const previousBody = payload.changes?.body?.from;
        const nowChecked = isCheckboxChecked(payload.comment.body);
        const wasChecked = previousBody !== undefined && isCheckboxChecked(previousBody);
        if (nowChecked && !wasChecked) {
            return { act: true, reason: "issue_comment edited: checkbox newly checked" };
        }
        return { act: false, reason: "edited comment's checkbox was not newly checked" };
    }
    return { act: false, reason: `issue_comment action '${payload.action}' is not a trigger` };
}
