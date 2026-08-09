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
 * whole matrix testable without a single mock.
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
    // trigger, which fires `issue_comment: edited` again. Without this guard
    // that is an infinite loop: our own edit is itself a checkbox transition,
    // and (separately) our own initial post mentions "/ackt" in its body.
    // Checked before the created/edited branches below so it applies to both.
    if (payload.comment.user.login === BOT_LOGIN) {
        return { act: false, reason: "comment is from the bot itself — refusing to self-trigger" };
    }
    if (payload.action === "created") {
        if (ACKT_COMMAND_RE.test(payload.comment.body)) {
            return { act: true, reason: "issue_comment created with /ackt" };
        }
        return { act: false, reason: "new comment does not contain /ackt at the start of a line" };
    }
    if (payload.action === "edited") {
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
