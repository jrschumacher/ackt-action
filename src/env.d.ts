/**
 * Minimal ambient declarations for the handful of Node built-ins `index.ts`
 * and `ancestry.ts` need (`process.env`, `node:fs`'s
 * `readFileSync`/`appendFileSync`, `node:child_process`'s `execFileSync`).
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
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function appendFileSync(path: string, data: string): void;
}

/**
 * `execFileSync` is the one synchronous, throwing primitive `ancestry.ts`
 * needs — see that module's `isAncestor` for why the *shape* of what it
 * throws (an `Error` carrying `status`) is load-bearing, not incidental:
 * exit code `1` and everything else mean different things.
 */
declare module "node:child_process" {
  export function execFileSync(command: string, args: readonly string[], options: { readonly stdio: "ignore" }): unknown;
}
