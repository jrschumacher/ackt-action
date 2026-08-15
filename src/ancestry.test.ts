import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeAncestryVerdicts, isAncestor } from "./ancestry.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

const COMMIT = "1".repeat(40);
const HEAD = "2".repeat(40);

/** Builds a synthetic execFileSync failure carrying `status`, the way Node's real one does. */
function execError(status: number): Error & { status?: number } {
  const error = new Error(`Command failed`) as Error & { status?: number };
  error.status = status;
  return error;
}

/**
 * `computeAncestryVerdicts` probes `git rev-parse --is-shallow-repository`
 * before it fetches or compares anything (C1). Every test below that expects
 * verdicts has to answer that probe with a literal `false` — an unanswered
 * probe is read as "cannot tell", which is deliberately no verdicts at all.
 *
 * Queued as a one-shot so it composes with the `mockReturnValueOnce` chains
 * the tests already use: vitest serves one-shots in registration order, ahead
 * of any default implementation.
 */
function answerNotShallow(): void {
  mockExecFileSync.mockImplementationOnce(() => "false\n");
}

/** The shallow guard's `::warning::` — captured so it doesn't spray the test output, and asserted on where it matters. */
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockExecFileSync.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe("isAncestor", () => {
  it("returns true when git checks and the commit is an ancestor — exit 0", () => {
    mockExecFileSync.mockReturnValue(undefined);
    expect(isAncestor(COMMIT, HEAD)).toBe(true);
  });

  // The whole correctness story (task-7 brief): exit 1 means git checked and
  // answered "no." Nothing else may be read that way.
  it("returns false only on exit code 1 — git checked and definitively said no", () => {
    // First call (fetch) succeeds; second call (merge-base) throws status 1.
    mockExecFileSync.mockReturnValueOnce(undefined).mockImplementationOnce(() => {
      throw execError(1);
    });
    expect(isAncestor(COMMIT, HEAD)).toBe(false);
  });

  it("returns null (never false) when merge-base exits 128 — git could not answer", () => {
    mockExecFileSync.mockReturnValueOnce(undefined).mockImplementationOnce(() => {
      throw execError(128);
    });
    expect(isAncestor(COMMIT, HEAD)).toBeNull();
  });

  it("returns null when merge-base throws with no status at all", () => {
    mockExecFileSync.mockReturnValueOnce(undefined).mockImplementationOnce(() => {
      throw new Error("some other failure");
    });
    expect(isAncestor(COMMIT, HEAD)).toBeNull();
  });

  it("returns null when the commit cannot be fetched from origin at all — genuinely gone", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw execError(128);
    });
    expect(isAncestor(COMMIT, HEAD)).toBeNull();
    // merge-base must never run against an object we couldn't even fetch.
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("fetches the commit directly from origin before checking ancestry", () => {
    mockExecFileSync.mockReturnValue(undefined);
    isAncestor(COMMIT, HEAD);
    // No --depth here — see ancestry.ts's comment at this call site for why
    // a shallow fetch of the commit must never come back.
    expect(mockExecFileSync).toHaveBeenNthCalledWith(1, "git", ["fetch", "--quiet", "origin", COMMIT], { stdio: "ignore" });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(2, "git", ["merge-base", "--is-ancestor", COMMIT, HEAD], { stdio: "ignore" });
  });
});

describe("computeAncestryVerdicts", () => {
  it("skips a head equal to the current head without calling git at all", () => {
    const verdicts = computeAncestryVerdicts([HEAD], HEAD);
    expect(verdicts.size).toBe(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("maps a true isAncestor result to 'advanced'", () => {
    answerNotShallow();
    mockExecFileSync.mockReturnValue(undefined);
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.get(COMMIT)).toBe("advanced");
  });

  it("maps a false isAncestor result to 'rewritten'", () => {
    // Call order: rev-parse --is-shallow-repository (false), fetch
    // currentHead (succeeds), fetch COMMIT (succeeds), merge-base
    // --is-ancestor (exits 1).
    answerNotShallow();
    mockExecFileSync
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw execError(1);
      });
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.get(COMMIT)).toBe("rewritten");
  });

  it("omits a head entirely when isAncestor returns null — never guesses a verdict", () => {
    // The currentHead fetch succeeds; COMMIT's own fetch (inside isAncestor)
    // is what fails here — see the dedicated tests below for a failed
    // currentHead fetch instead.
    answerNotShallow();
    mockExecFileSync.mockImplementationOnce(() => undefined).mockImplementation(() => {
      throw execError(128);
    });
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.has(COMMIT)).toBe(false);
    expect(verdicts.size).toBe(0);
  });

  it("probes for a shallow clone first, then fetches the current head from origin without --depth", () => {
    answerNotShallow();
    mockExecFileSync.mockReturnValue(undefined);
    computeAncestryVerdicts([COMMIT], HEAD);
    // The shallow probe comes before any network call — the answer decides
    // whether the rest is worth doing at all (C1).
    expect(mockExecFileSync).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(2, "git", ["fetch", "--quiet", "origin", HEAD], { stdio: "ignore" });
    // Then isAncestor's own fetch of the attested head, then merge-base.
    expect(mockExecFileSync).toHaveBeenNthCalledWith(3, "git", ["fetch", "--quiet", "origin", COMMIT], { stdio: "ignore" });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(4, "git", ["merge-base", "--is-ancestor", COMMIT, HEAD], { stdio: "ignore" });
  });

  it("does not fetch or call isAncestor at all when there are no candidate heads, even if currentHead would fail to fetch", () => {
    const verdicts = computeAncestryVerdicts([HEAD], HEAD);
    expect(verdicts.size).toBe(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("a failed current-head fetch yields no verdicts, never a false one, and never throws", () => {
    answerNotShallow();
    mockExecFileSync.mockImplementation(() => {
      throw execError(128);
    });
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.size).toBe(0);
    // Only the shallow probe and the currentHead fetch ran — isAncestor (and its own fetch/merge-base) never did.
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(2, "git", ["fetch", "--quiet", "origin", HEAD], { stdio: "ignore" });
  });

  it("a failed current-head fetch produces unknown for every candidate, not just the first", () => {
    answerNotShallow();
    mockExecFileSync.mockImplementation(() => {
      throw execError(128);
    });
    const other = "6".repeat(40);
    const verdicts = computeAncestryVerdicts([COMMIT, other], HEAD);
    expect(verdicts.size).toBe(0);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("computes an independent verdict per head, skipping only the current one", () => {
    const advanced = "3".repeat(40);
    const rewritten = "4".repeat(40);
    const unknown = "5".repeat(40);

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argv = args as readonly string[];
      if (argv[0] === "rev-parse") return "false\n";
      if (argv[0] === "fetch") {
        if (argv[4] === unknown) throw execError(128); // can't even fetch this one
        return undefined;
      }
      // merge-base --is-ancestor <commit> <head>
      const commit = argv[2];
      if (commit === advanced) return undefined;
      if (commit === rewritten) throw execError(1);
      throw execError(128);
    });

    const verdicts = computeAncestryVerdicts([advanced, rewritten, unknown, HEAD], HEAD);
    expect(verdicts.get(advanced)).toBe("advanced");
    expect(verdicts.get(rewritten)).toBe("rewritten");
    expect(verdicts.has(unknown)).toBe(false);
    expect(verdicts.has(HEAD)).toBe(false);
    expect(verdicts.size).toBe(2);
  });

  // C1. The behaviour these four pin down is proved against a real
  // `git clone --depth=1` in ancestry.realgit.test.ts; these only pin down
  // that the probe's answer is what decides, and that nothing else runs.
  it("reports no verdict at all from a shallow clone, and never reaches git's ancestry answer", () => {
    mockExecFileSync.mockImplementationOnce(() => "true\n");
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.size).toBe(0);
    // Nothing after the probe: no fetch, and above all no merge-base, whose
    // exit 1 in a shallow clone is the confident false 'rewritten' (C1).
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("warns, naming fetch-depth: 0, when it skips a shallow clone", () => {
    mockExecFileSync.mockImplementationOnce(() => "true\n");
    computeAncestryVerdicts([COMMIT], HEAD);
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("::warning::");
    expect(message).toContain("fetch-depth: 0");
  });

  it("treats a shallow probe git could not answer as shallow — cannot tell is never a verdict", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw execError(128);
    });
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.size).toBe(0);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("treats any answer other than a literal 'false' as shallow", () => {
    mockExecFileSync.mockImplementationOnce(() => "");
    expect(computeAncestryVerdicts([COMMIT], HEAD).size).toBe(0);
  });

  it("returns an empty map when there are no attested heads at all", () => {
    const verdicts = computeAncestryVerdicts([], HEAD);
    expect(verdicts.size).toBe(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
