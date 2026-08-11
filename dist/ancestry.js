/**
 * Local git ancestry checks — the impure half of the two-phase exchange
 * (docs/superpowers/specs/2026-08-11-dashboard-design.md, "Two-phase: git
 * answers the question git can answer"). `query.ts` stays a pure URL/body
 * builder and response parser; this module is where `execFileSync` and the
 * checked-out repository actually get touched, because only git can answer
 * "is this commit still reachable from that one" and only a local clone can
 * ask it.
 *
 * Both sides of every ancestry comparison are fetched from origin by exact
 * SHA before git is asked anything (`fetchCommit`, below) — an attested head
 * because it may already be rewritten out of history, the pull request's
 * current head because `actions/checkout`'s default ref is never the PR's
 * real head on either trigger this Action listens for (see
 * `computeAncestryVerdicts`'s doc comment). That is what lets this module
 * answer correctly regardless of what a caller's checkout step produced on
 * disk — the only thing a workflow still has to get right is
 * `fetch-depth: 0`, so the *history between* those two fetched commits is
 * actually there; see the README's "Full history" section.
 */
import { execFileSync } from "node:child_process";
/**
 * Fetches a single commit by exact SHA from origin so it exists in the
 * local clone before git is asked anything about it. Shared by `isAncestor`
 * (an attested head, which may be unreachable from every ref if it was
 * force-pushed away) and `computeAncestryVerdicts` (the pull request's
 * current head, which `actions/checkout` never guarantees is on disk).
 * GitHub serves retained unreachable objects by SHA, so ask for it directly
 * rather than relying on whatever ref got checked out.
 *
 * NEVER add --depth=1 (or any --depth) back to this fetch. In a full
 * (non-shallow) clone, a shallow fetch writes .git/shallow and truncates
 * the fetched commit's own parents from that point on -- it does not stay
 * scoped to the one commit requested. Reviewed and reproduced directly: on
 * a linear 6-commit history, `is-ancestor(A, H)` correctly exits 0 before
 * any shallow fetch, then a `--depth=1` fetch of a *later* commit B alone
 * is enough to make that same `is-ancestor(A, H)` exit 1 afterwards -- and
 * exit 1 is the one code this function's callers treat as trustworthy ("git
 * checked and the answer is no"), so this doesn't degrade to unknown, it
 * produces a confident, false *rewritten* verdict. Reachable in practice:
 * attesting the tip and later attesting an older commit via the attest
 * page's manual head override is enough, since `attested_heads`
 * (verified_at ASC) then fetches the tip first. Fetching a single SHA
 * without a depth limit is already cheap -- there is no performance case
 * for reintroducing this.
 */
function fetchCommit(sha) {
    try {
        execFileSync("git", ["fetch", "--quiet", "origin", sha], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Exact, and the reason the merge-base commit set was abandoned: membership in
 * any set proves "still here" but never "gone". --is-ancestor is the actual
 * question.
 *
 * Any failure — shallow checkout, missing commit, wrong HEAD — reports nothing
 * for that head, which the service records as unknown. A failure never
 * produces a verdict, so a misconfigured workflow cannot claim someone's
 * commit was erased.
 */
export function isAncestor(commit, head) {
    // A force-pushed-away commit is unreachable from every ref, so no clone
    // contains it -- not even at fetch-depth 0. Without this fetch,
    // --is-ancestor exits 128 ("bad object"), which the rule below correctly
    // reads as "cannot tell", and *rewritten* would essentially never fire.
    // See fetchCommit's own doc comment for why this can never gain --depth.
    if (!fetchCommit(commit)) {
        return null; // the object is genuinely gone from the remote: unknown
    }
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", commit, head], { stdio: "ignore" });
        return true;
    }
    catch (error) {
        const code = error.status;
        if (code === 1)
            return false; // git checked: definitively not an ancestor
        return null; // 128 or anything else: git could not answer
    }
}
/**
 * Computes a verdict for every attested head phase one reported, except the
 * current one — the Action never asks git about a head it already knows is
 * current, and the service marks that case `current` on its own (design
 * doc's "no verdict reported" table; the service's `handleGetAckt`/
 * `handlePostAncestry` doc comments).
 *
 * `currentHead` must be the pull request's real, current head SHA — resolved
 * from the GitHub API (`client.getPullRequest`, index.ts), **never the
 * literal git ref `HEAD`**. This function fetches that exact SHA from origin
 * itself (`fetchCommit`) before comparing anything against it, the same way
 * `isAncestor` already fetches an attested head — so it no longer matters
 * which ref a caller's checkout step left on disk. `actions/checkout` gives
 * you the *merge ref* on `pull_request` and the *default branch* on
 * `issue_comment`; neither is the PR's head, which is why this can't rely on
 * the checked-out `HEAD` ref instead of fetching this explicit SHA. See the
 * README's "Full history" section for the one thing a caller's checkout
 * step still has to get right: `fetch-depth: 0`, so the history *between*
 * the fetched commits is actually present — fetching the two endpoints by
 * SHA does not substitute for that.
 *
 * `isAncestor` returning `null` (git could not answer) is omitted entirely,
 * never sent as anything — the wire format `postAncestry` builds only ever
 * carries `advanced`/`rewritten` (`AncestryVerdict`); "no verdict reported"
 * is itself how the service learns to say `unknown`, so there is nothing to
 * encode for that case. A failed fetch of `currentHead` itself is the same
 * story: every candidate head below is simply never given a verdict, never
 * a guess, and this never throws — a bad head fetch must not fail the run.
 */
export function computeAncestryVerdicts(attestedHeads, currentHead) {
    const verdicts = new Map();
    const candidates = attestedHeads.filter((head) => head !== currentHead);
    if (candidates.length === 0)
        return verdicts;
    if (!fetchCommit(currentHead)) {
        return verdicts; // git could not even fetch the head we'd compare against: unknown for every candidate
    }
    for (const head of candidates) {
        const result = isAncestor(head, currentHead);
        if (result === true)
            verdicts.set(head, "advanced");
        else if (result === false)
            verdicts.set(head, "rewritten");
    }
    return verdicts;
}
