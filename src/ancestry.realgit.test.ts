/**
 * Regression coverage for the final-review finding (IMPORTANT 2): a
 * `--depth=1` fetch of one commit can retroactively sever the ancestry of an
 * *unrelated, already-known* commit in a full clone, because it writes
 * `.git/shallow` and truncates the fetched commit's parents rather than
 * staying scoped to the one object requested.
 *
 * Deliberately a separate file from `ancestry.test.ts`: that file
 * `vi.mock`s `node:child_process` so its assertions can check exact argv
 * without touching a filesystem; this file needs the opposite — a real git
 * binary and a real repository — so `isAncestor` runs completely
 * unmocked here. `computeAncestryVerdicts` (and `isAncestor` before this
 * fix) was previously only ever exercised against a stubbed `isAncestor` —
 * exactly why a bug in what `isAncestor` actually shells out to survived
 * eight rounds of task-scoped review.
 */

import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { isAncestor } from "./ancestry.js";

function sh(cwd: string, command: string, args: readonly string[]): string {
  return (execFileSync(command, args, { cwd, encoding: "utf8" }) as string).trim();
}

function git(cwd: string, args: readonly string[]): string {
  return sh(cwd, "git", args);
}

function commit(cwd: string, message: string): string {
  git(cwd, ["commit", "--allow-empty", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

let tmpRoot: string | undefined;
let originalCwd: string | undefined;

afterEach(() => {
  if (originalCwd !== undefined) {
    process.chdir(originalCwd);
    originalCwd = undefined;
  }
  if (tmpRoot !== undefined) {
    execFileSync("rm", ["-rf", tmpRoot]);
    tmpRoot = undefined;
  }
});

describe("isAncestor against a real git repository", () => {
  // The reviewer's own reproduction, reduced to the two facts that matter:
  // (1) is-ancestor is correct before any shallow fetch happens, and (2) a
  // --depth=1 fetch of a later, *unrelated* commit must never flip that
  // answer. This test builds a real linear 6-commit history, clones it
  // fully (so both commits are already present, the way a fetch-depth: 0
  // checkout leaves them), and drives the real `isAncestor` — not a stub —
  // against it.
  it("a shallow fetch of a later commit must not retroactively sever an earlier commit's ancestry", () => {
    tmpRoot = (execFileSync("mktemp", ["-d"], { encoding: "utf8" }) as string).trim();
    const remoteDir = `${tmpRoot}/remote`;
    const localDir = `${tmpRoot}/local`;
    execFileSync("mkdir", ["-p", remoteDir]);

    git(remoteDir, ["init", "--quiet"]);
    git(remoteDir, ["config", "user.email", "test@example.invalid"]);
    git(remoteDir, ["config", "user.name", "ackt-test"]);
    const shaA = commit(remoteDir, "A"); // the older, attested commit
    const shaB = commit(remoteDir, "B"); // an unrelated later commit the buggy fetch targets
    commit(remoteDir, "C");
    commit(remoteDir, "D");
    commit(remoteDir, "E");
    const shaHead = commit(remoteDir, "F"); // the PR's current head

    // A full clone: both A and B are already present as objects, the same
    // state a fetch-depth: 0 checkout leaves a workflow in.
    execFileSync("git", ["clone", "--quiet", remoteDir, localDir]);

    // isAncestor shells out relative to process.cwd() (the real Action
    // always runs from the checked-out workspace root) — no cwd parameter
    // to pass, so the test has to actually be there.
    originalCwd = process.cwd();
    process.chdir(localDir);

    // Sanity check: correct before touching anything.
    expect(isAncestor(shaA, shaHead)).toBe(true);

    // This is the regression itself: asking isAncestor about a completely
    // different, unrelated commit (B) must never change the answer already
    // established for A.
    expect(isAncestor(shaB, shaHead)).toBe(true);
    expect(isAncestor(shaA, shaHead)).toBe(true);
  });
});
