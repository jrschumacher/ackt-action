/**
 * Regression coverage for the final-review finding (IMPORTANT 2): a
 * `--depth=1` fetch of one commit can retroactively sever the ancestry of an
 * *unrelated, already-known* commit in a full clone, because it writes
 * `.git/shallow` and truncates the fetched commit's parents rather than
 * staying scoped to the one object requested.
 *
 * Also covers the workflow-snippet simplification: `computeAncestryVerdicts`
 * now fetches the pull request's current head itself (`fetchCommit`,
 * ancestry.ts) rather than depending on the workflow's checkout step to have
 * produced that exact SHA on disk. That is Action runtime behaviour against
 * a real git object database — allowing an arbitrary, non-tip SHA to be
 * fetched by name, and a fetch of a genuinely nonexistent SHA to fail — so
 * it belongs here rather than behind a stubbed `execFileSync`, for the same
 * reason the shallow-fetch regression above does.
 *
 * Deliberately a separate file from `ancestry.test.ts`: that file
 * `vi.mock`s `node:child_process` so its assertions can check exact argv
 * without touching a filesystem; this file needs the opposite — a real git
 * binary and a real repository — so `isAncestor` and `computeAncestryVerdicts`
 * run completely unmocked here. `computeAncestryVerdicts` (and `isAncestor`
 * before this fix) was previously only ever exercised against a stubbed
 * `isAncestor` — exactly why a bug in what `isAncestor` actually shells out
 * to survived eight rounds of task-scoped review.
 */

import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { computeAncestryVerdicts, isAncestor } from "./ancestry.js";

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

/** A freshly `git init`'d directory, ready to commit into — used as the "remote" side of a clone in every test below. */
function initRepo(cwd: string): void {
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "ackt-test"]);
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

    initRepo(remoteDir);
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

describe("computeAncestryVerdicts fetching its own current head against a real git repository", () => {
  // The workflow-snippet simplification's whole premise: the local
  // workspace's checked-out ref no longer has to be the PR's real head for
  // ancestry to be answerable. This builds a clone that predates the head
  // being compared against — the same situation a stale checkout leaves a
  // caller in on `synchronize`, or a default-branch checkout leaves it in on
  // `issue_comment` — and drives the real, unmocked `computeAncestryVerdicts`
  // against it.
  it("fetches a current head that postdates the local clone, and still reports the correct verdict", () => {
    tmpRoot = (execFileSync("mktemp", ["-d"], { encoding: "utf8" }) as string).trim();
    const remoteDir = `${tmpRoot}/remote`;
    const localDir = `${tmpRoot}/local`;
    execFileSync("mkdir", ["-p", remoteDir]);

    initRepo(remoteDir);
    const shaA = commit(remoteDir, "A"); // the attested head

    // Clone while the remote only has A — the local workspace has no idea
    // the commits below will ever exist, the same way actions/checkout runs
    // once, before this Action does anything.
    execFileSync("git", ["clone", "--quiet", remoteDir, localDir]);

    commit(remoteDir, "B");
    const shaHead = commit(remoteDir, "C"); // the PR's real current head, resolved from the API — never on disk yet

    originalCwd = process.cwd();
    process.chdir(localDir);

    // Sanity: the current head genuinely is not a local object yet.
    expect(() => git(localDir, ["cat-file", "-t", shaHead])).toThrow();

    const verdicts = computeAncestryVerdicts([shaA], shaHead);
    expect(verdicts.get(shaA)).toBe("advanced");

    // And now it is, proving the verdict came from a real fetch, not a
    // coincidence of what the clone already had.
    expect(git(localDir, ["cat-file", "-t", shaHead])).toBe("commit");
  });

  it("a current head that cannot be fetched at all yields no verdicts and does not throw", () => {
    tmpRoot = (execFileSync("mktemp", ["-d"], { encoding: "utf8" }) as string).trim();
    const remoteDir = `${tmpRoot}/remote`;
    const localDir = `${tmpRoot}/local`;
    execFileSync("mkdir", ["-p", remoteDir]);

    initRepo(remoteDir);
    const shaA = commit(remoteDir, "A");
    execFileSync("git", ["clone", "--quiet", remoteDir, localDir]);

    originalCwd = process.cwd();
    process.chdir(localDir);

    const bogusHead = "9".repeat(40); // never existed anywhere, so origin refuses to serve it
    let verdicts: ReturnType<typeof computeAncestryVerdicts> | undefined;
    expect(() => {
      verdicts = computeAncestryVerdicts([shaA], bogusHead);
    }).not.toThrow();
    expect(verdicts?.size).toBe(0);
  });

  // The regression above (IMPORTANT 2) proved a --depth=1 fetch of an
  // attested head can retroactively shallow the whole clone. This proves
  // the same must hold for the *current head* fetch this task adds: fetching
  // a current head that postdates the clone must not write .git/shallow or
  // sever the ancestry of a commit pair that was already correct.
  it("fetching the current head does not shallow the clone or sever an unrelated, already-known ancestry", () => {
    tmpRoot = (execFileSync("mktemp", ["-d"], { encoding: "utf8" }) as string).trim();
    const remoteDir = `${tmpRoot}/remote`;
    const localDir = `${tmpRoot}/local`;
    execFileSync("mkdir", ["-p", remoteDir]);

    initRepo(remoteDir);
    const shaA = commit(remoteDir, "A");
    commit(remoteDir, "B");
    commit(remoteDir, "C");
    commit(remoteDir, "D");
    const shaE = commit(remoteDir, "E"); // already fully present locally after the clone below

    // A full clone: A..E are already present, the same state a
    // fetch-depth: 0 checkout leaves a workflow in.
    execFileSync("git", ["clone", "--quiet", remoteDir, localDir]);

    // A new commit lands after the clone — this is the PR's real current
    // head by the time the Action runs, and it is not on disk yet.
    const shaHead = commit(remoteDir, "F");

    originalCwd = process.cwd();
    process.chdir(localDir);

    // Sanity, established before the current-head fetch runs at all.
    expect(isAncestor(shaA, shaE)).toBe(true);

    const verdicts = computeAncestryVerdicts([shaA], shaHead);
    expect(verdicts.get(shaA)).toBe("advanced");

    // The fetch of the new head must not have shallowed the repository...
    expect(git(localDir, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    // ...and must not have severed the unrelated, already-established A→E ancestry.
    expect(isAncestor(shaA, shaE)).toBe(true);
  });
});
