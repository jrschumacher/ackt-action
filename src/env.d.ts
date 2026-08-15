/**
 * Minimal ambient declarations for the handful of Node built-ins `index.ts`,
 * `ancestry.ts`, and `ancestry.realgit.test.ts` need (`process.env`,
 * `node:fs`'s `readFileSync`/`appendFileSync`, `node:child_process`'s
 * `execFileSync`). `process.cwd`/`process.chdir` and `execFileSync`'s
 * `cwd`/`encoding` options exist only for that last one — building and
 * driving a real temporary git repository is easiest by shelling out
 * (`mktemp`, `rm`, `git`) rather than pulling in `node:fs`/`node:os`/
 * `node:path` for the same job, so `execFileSync` covers it too rather than
 * growing the ambient surface with a second I/O primitive.
 *
 * Deliberately hand-written instead of pulling in `@types/node`: the whole
 * point of this action is zero runtime dependencies and no bundler, and a
 * `@types/node` dev dependency is easy to reach for but unnecessary — this
 * action touches a handful of Node APIs, not the whole standard library.
 * `fetch`, `URL`, `URLSearchParams`, and `Response` come from `lib.dom.d.ts`
 * instead (see tsconfig.json's `lib`), which is the same trick, applied to
 * the other half of what index.ts and query.ts need.
 */

declare const process: {
  readonly env: Record<string, string | undefined>;
  exitCode?: number;
  cwd(): string;
  chdir(directory: string): void;
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function appendFileSync(path: string, data: string): void;
}

/**
 * `execFileSync` is the one synchronous, throwing primitive `ancestry.ts`
 * needs — see that module's `isAncestor` for why the *shape* of what it
 * throws (an `Error` carrying `status`) is load-bearing, not incidental:
 * exit code `1` and everything else mean different things. `cwd`/`encoding`
 * are additionally used by `ancestry.realgit.test.ts` to set up and drive a
 * throwaway git repository; return type stays `unknown` regardless (rather
 * than typing the `encoding`-present overload as `string`) since there's no
 * `Buffer` type available without `@types/node` for the other branch, and
 * every caller casts explicitly at the one call site that needs a string.
 *
 * `stdio` also accepts the per-stream tuple form, for the one call that wants
 * both halves of it at once: `isShallowRepository` has to *read* stdout (so
 * not `"ignore"`) while still discarding stderr (so not the default), which
 * only `["ignore", "pipe", "ignore"]` expresses.
 */
declare module "node:child_process" {
  export function execFileSync(
    command: string,
    args: readonly string[],
    options?: {
      readonly stdio?: "ignore" | readonly ("ignore" | "pipe" | "inherit")[];
      readonly cwd?: string;
      readonly encoding?: "utf8";
    },
  ): unknown;
}
