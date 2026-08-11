import { execFileSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  mockExecFileSync.mockReset();
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
    mockExecFileSync.mockReturnValue(undefined);
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.get(COMMIT)).toBe("advanced");
  });

  it("maps a false isAncestor result to 'rewritten'", () => {
    mockExecFileSync.mockReturnValueOnce(undefined).mockImplementationOnce(() => {
      throw execError(1);
    });
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.get(COMMIT)).toBe("rewritten");
  });

  it("omits a head entirely when isAncestor returns null — never guesses a verdict", () => {
    mockExecFileSync.mockImplementation(() => {
      throw execError(128);
    });
    const verdicts = computeAncestryVerdicts([COMMIT], HEAD);
    expect(verdicts.has(COMMIT)).toBe(false);
    expect(verdicts.size).toBe(0);
  });

  it("computes an independent verdict per head, skipping only the current one", () => {
    const advanced = "3".repeat(40);
    const rewritten = "4".repeat(40);
    const unknown = "5".repeat(40);

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argv = args as readonly string[];
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

  it("returns an empty map when there are no attested heads at all", () => {
    const verdicts = computeAncestryVerdicts([], HEAD);
    expect(verdicts.size).toBe(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
