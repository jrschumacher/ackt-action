/**
 * The shell that wires the pure modules to GithubClient calls in the right
 * order. This is the only part unit tests can't reach — it reads env vars,
 * reads the event payload off disk, and makes real HTTP calls. Every
 * decision with a branch in it belongs in trigger.ts, comment.ts, or
 * query.ts instead, where it's tested without a live GitHub API or event
 * file. Keep it thin; resist the urge to grow logic here just because it's
 * convenient mid-wiring.
 */

import { appendFileSync, readFileSync } from "node:fs";

import { computeAncestryVerdicts } from "./ancestry.js";
import { attestUrl, buildCommentHistory, findAcktComment, recordUrl, renderComment, resetCheckbox, type CommentInput } from "./comment.js";
import { GithubClient } from "./github.js";
import { FORK_DEGRADED_MESSAGE, mintOidcToken, oidcEndpointPresent } from "./oidc.js";
import { postAncestry, queryAckt, queryAttestations, type FetchLike } from "./query.js";
import { decideTrigger, isForkPullRequest } from "./trigger.js";

function getInput(name: string): string {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? "";
}

function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile !== undefined && outputFile.length > 0) {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

const fetchImpl: FetchLike = (url, init) => fetch(url, init);

/**
 * Runs a GitHub write that GitHub itself may refuse on a fork-origin run, and
 * lets that refusal degrade instead of failing the job.
 *
 * The same policy that withholds the OIDC token from a fork `pull_request`
 * also downgrades `GITHUB_TOKEN`: "If the workflow was triggered by a pull
 * request event other than `pull_request_target` from a forked repository …
 * the permissions are adjusted to change any write permissions to read only"
 * (GitHub's workflow-syntax reference, `permissions`). So on a fork run the
 * status check, the comment and the reactions can all come back 403 no matter
 * what the workflow declares — and without this the I4 fix would only move
 * the red run a few lines later, still breaking what
 * `fail-on-unattested: false` promises.
 *
 * Scoped to `forkRun` deliberately, and rethrows everywhere else: a 403 on a
 * same-repository run is a real misconfiguration the maintainer can fix, and
 * swallowing it would leave a workflow silently posting nothing.
 */
async function tolerateOnForkRun<T>(forkRun: boolean, what: string, operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (!forkRun) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`::warning::ackt could not ${what}: GitHub gives a fork pull request's workflow a read-only token, so this run cannot write to the pull request. ${message}`);
    return null;
  }
}

async function run(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";

  const repoParts = repository.split("/");
  const owner = repoParts[0];
  const repo = repoParts[1];
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new Error(`GITHUB_REPOSITORY is not in 'owner/repo' form: '${repository}'`);
  }

  const service = getInput("service") || "https://ackt.dev";
  const failOnUnattested = getInput("fail-on-unattested") === "true";
  const token = getInput("github-token") || process.env.GITHUB_TOKEN || "";

  const payload = JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown>;
  const decision = decideTrigger(eventName, payload);
  console.log(`ackt: ${decision.reason}`);
  setOutput("acted", String(decision.act));
  if (!decision.act) {
    return;
  }

  // Minted before anything is posted, so a workflow missing `id-token: write`
  // fails with one clear message and no half-finished side effects — no 👀
  // reaction on a comment that will never get an answer, no status check.
  // Deliberately after the trigger decision: most `issue_comment` events are
  // not ackt's business and must not fail anyone's workflow.
  //
  // With exactly one exception, and it is the common case rather than an edge:
  // a `pull_request` from a fork never gets a minting endpoint, whatever
  // permissions the workflow declares. Failing there told a maintainer to add
  // a permission that was already present, and turned the run red in the teeth
  // of `fail-on-unattested: false`. So: degrade, and say why. `null` means "no
  // token, legitimately" — the query goes out unauthenticated (answered for
  // public repositories), nothing is recorded, and no ancestry is reported.
  // Any *other* absence still throws, because it still means what it used to.
  const forkRun = isForkPullRequest(eventName, payload) && !oidcEndpointPresent(process.env);
  if (forkRun) console.warn(`::warning::${FORK_DEGRADED_MESSAGE}`);
  const acktToken = forkRun ? null : await mintOidcToken(process.env, fetchImpl);

  const client = new GithubClient(token);

  let prNumber: number;
  let triggerCommentId: number | undefined;
  if (eventName === "pull_request") {
    prNumber = (payload.pull_request as { readonly number: number }).number;
  } else {
    prNumber = (payload.issue as { readonly number: number }).number;
    triggerCommentId = (payload.comment as { readonly id: number }).id;
  }

  if (triggerCommentId !== undefined) {
    await tolerateOnForkRun(forkRun, "react to the triggering comment", () => client.addReaction(owner, repo, triggerCommentId, "eyes"));
  }

  // Always resolved from the API, never the event payload: it's stale on
  // `synchronize` and carries no head at all on `issue_comment`.
  const pr = await client.getPullRequest(owner, repo, prNumber);
  const actor = pr.user.login;
  const head = pr.head.sha;

  const result = await queryAckt({ service, repo: `${owner}/${repo}`, pr: prNumber, actor, head }, fetchImpl, acktToken);

  const link = attestUrl(service, owner, repo, prNumber, head);
  await tolerateOnForkRun(forkRun, "post the commit status", () => client.createStatus(owner, repo, head, {
    state: result.attested ? "success" : "pending",
    context: "ackt / human-review",
    description: result.attested
      ? `Attested by @${actor} at ${head.slice(0, 7)}`
      : `@${actor}, attest this PR — see the comment below`,
    // SPEC §4.8: "the record's permalink on the service". Only the *pending*
    // state has anyone left to send to the attest form; on a green check the
    // most likely click in the product is a reviewer asking "who attested
    // this?", and `attestUrl` answered that by bouncing them through GitHub's
    // OAuth consent into a form inviting them to attest someone else's
    // commit. `recordUrl`'s doc comment has the long version. Both are built
    // from the `service` input, so a self-hosted deployment links to itself.
    target_url: result.attested ? recordUrl(service, owner, repo, prNumber) : link,
  }));

  // Timestamps and history come from the service's own records — never this
  // run's clock (a re-run would rewrite the date on a claim about when a
  // person acted) and never nothing at all (which is what made the comment's
  // "stale" state unreachable, so a push erased the history from the one
  // surface everybody reads). Best-effort by design: this buys presentation
  // only, so a failure degrades the comment and never the run. Without it the
  // attested sentence simply omits its date and a stale head renders as
  // "awaiting" — the pre-fix behaviour, now the fallback rather than the rule.
  let history: Pick<CommentInput, "recordedAt" | "priorAttestations"> = {};
  try {
    const records = await queryAttestations({ service, repo: `${owner}/${repo}`, pr: prNumber }, fetchImpl, acktToken);
    history = buildCommentHistory(records, actor, head);
  } catch (error) {
    console.warn(`::warning::ackt could not read this pull request's attestation record; the comment omits timestamps and history: ${error instanceof Error ? error.message : String(error)}`);
  }

  const comments = await client.listComments(owner, repo, prNumber);
  const existing = findAcktComment(comments);
  const body = resetCheckbox(
    renderComment({
      service,
      owner,
      repo,
      pr: prNumber,
      actor,
      headSha: head,
      attested: result.attested,
      ...history,
    }),
  );

  if (existing === null) {
    await tolerateOnForkRun(forkRun, "post its comment", () => client.createComment(owner, repo, prNumber, body));
  } else {
    await tolerateOnForkRun(forkRun, "update its comment", () => client.updateComment(owner, repo, existing.id, body));
  }

  // Posted last, after the comment and status reflect this run's query
  // result, so the visible reaction always matches what's already live.
  if (triggerCommentId !== undefined) {
    await tolerateOnForkRun(forkRun, "react to the triggering comment", () => client.addReaction(owner, repo, triggerCommentId, result.attested ? "+1" : "-1"));
  }

  // Phase two and three of the two-phase ancestry exchange
  // (docs/superpowers/specs/2026-08-11-dashboard-design.md): `result.attestedHeads`
  // is phase one, already in hand from the query above. Computed and
  // reported last, after every visible side effect (status, comment,
  // reactions) — this is dashboard bookkeeping, not part of the attestation
  // decision, and a failure here must never turn an otherwise-successful
  // run red. `acktToken` is reused rather than minted again (see its own
  // comment, above).
  try {
    // Skipped entirely without a token: `POST /api/v1/ancestry` has no
    // public-repo fallback (writing into a repository's audit trail can't
    // have one), so on a fork run there is nothing to send it to. That is the
    // degraded mode working as described, not a failure to report.
    if (acktToken !== null) {
      const verdicts = computeAncestryVerdicts(result.attestedHeads, head);
      if (verdicts.size > 0) {
        await postAncestry({ service, repo: `${owner}/${repo}`, pr: prNumber, actor, verdicts }, fetchImpl, acktToken);
      }
    }
  } catch (error) {
    console.warn(`::warning::ackt could not report commit ancestry to the service: ${error instanceof Error ? error.message : String(error)}`);
  }

  setOutput("attested", String(result.attested));

  if (failOnUnattested && !result.attested) {
    console.error("::error::fail-on-unattested is true and the PR author has not attested the current head.");
    process.exitCode = 1;
  }
}

run().catch((error: unknown) => {
  // `::error::` makes the message a workflow annotation — visible on the
  // summary page without opening the log, which is where someone whose
  // workflow is missing a permission will actually be looking. Newlines have
  // to be escaped or GitHub truncates the annotation at the first one.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${message.replace(/\r?\n/g, "%0A")}`);
  if (error instanceof Error && error.stack !== undefined) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
