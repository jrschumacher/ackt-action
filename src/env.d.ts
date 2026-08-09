/**
 * Minimal ambient declarations for the handful of Node built-ins `index.ts`
 * needs (`process.env`, `node:fs`'s `readFileSync`/`appendFileSync`).
 *
 * Deliberately hand-written instead of pulling in `@types/node`: the whole
 * point of this action is zero runtime dependencies and no bundler, and a
 * `@types/node` dev dependency is easy to reach for but unnecessary — this
 * action touches three Node APIs, not the whole standard library. `fetch`,
 * `URL`, `URLSearchParams`, and `Response` come from `lib.dom.d.ts` instead
 * (see tsconfig.json's `lib`), which is the same trick, applied to the
 * other half of what index.ts and query.ts need.
 */

declare const process: {
  readonly env: Record<string, string | undefined>;
  exitCode?: number;
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function appendFileSync(path: string, data: string): void;
}
