/**
 * Local git ancestry checks — the impure half of the two-phase exchange
 * (docs/superpowers/specs/2026-08-11-dashboard-design.md, "Two-phase: git
 * answers the question git can answer"). `query.ts` stays a pure URL/body
 * builder and response parser; this module is where `execFileSync` and the
 * checked-out repository actually get touched, because only git can answer
 * "is this commit still reachable from that one" and only a local clone can
 * ask it.
 *
 * The comparison head must be the pull request's real head, and it is not
 * by default on either trigger `actions/checkout` runs under — see
 * `computeAncestryVerdicts`'s doc comment and the README's "Full history"
 * section for what a caller of this module has to get right for these
 * answers to mean anything.
 */

import { execFileSync } from "node:child_process";

import type { AncestryVerdict } from "./query.js";

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
export function isAncestor(commit: string, head: string): boolean | null {
  // A force-pushed-away commit is unreachable from every ref, so no clone
  // contains it -- not even at fetch-depth 0. Without this fetch,
  // --is-ancestor exits 128 ("bad object"), which the rule below correctly
  // reads as "cannot tell", and *rewritten* would essentially never fire.
  // GitHub serves retained unreachable objects by SHA, so ask for it directly.
  try {
    execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", commit], { stdio: "ignore" });
  } catch {
    return null; // the object is genuinely gone from the remote: unknown
  }

  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, head], { stdio: "ignore" });
    return true;
  } catch (error) {
    const code = (error as { status?: number }).status;
    if (code === 1) return false; // git checked: definitively not an ancestor
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
 * literal git ref `HEAD`**. `actions/checkout` gives you the *merge ref* on
 * `pull_request` and the *default branch* on `issue_comment`; neither is the
 * PR's head, so comparing against the checked-out `HEAD` ref instead of this
 * explicit SHA would silently answer the wrong question on the more common
 * of the two triggers. See the README's "Full history" section for the
 * checkout this still requires.
 *
 * `isAncestor` returning `null` (git could not answer) is omitted entirely,
 * never sent as anything — the wire format `postAncestry` builds only ever
 * carries `advanced`/`rewritten` (`AncestryVerdict`); "no verdict reported"
 * is itself how the service learns to say `unknown`, so there is nothing to
 * encode for that case.
 */
export function computeAncestryVerdicts(attestedHeads: readonly string[], currentHead: string): ReadonlyMap<string, AncestryVerdict> {
  const verdicts = new Map<string, AncestryVerdict>();
  for (const head of attestedHeads) {
    if (head === currentHead) continue;
    const result = isAncestor(head, currentHead);
    if (result === true) verdicts.set(head, "advanced");
    else if (result === false) verdicts.set(head, "rewritten");
  }
  return verdicts;
}
