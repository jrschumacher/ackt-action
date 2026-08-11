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
import { attestUrl, findAcktComment, formatUtc, renderComment, resetCheckbox } from "./comment.js";
import { GithubClient } from "./github.js";
import { mintOidcToken } from "./oidc.js";
import { postAncestry, queryAckt, type FetchLike } from "./query.js";
import { decideTrigger } from "./trigger.js";

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
  const acktToken = await mintOidcToken(process.env, fetchImpl);

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
    await client.addReaction(owner, repo, triggerCommentId, "eyes");
  }

  // Always resolved from the API, never the event payload: it's stale on
  // `synchronize` and carries no head at all on `issue_comment`.
  const pr = await client.getPullRequest(owner, repo, prNumber);
  const actor = pr.user.login;
  const head = pr.head.sha;

  const result = await queryAckt({ service, repo: `${owner}/${repo}`, pr: prNumber, actor, head }, fetchImpl, acktToken);

  const link = attestUrl(service, owner, repo, prNumber, head);
  await client.createStatus(owner, repo, head, {
    state: result.attested ? "success" : "pending",
    context: "ackt / human-review",
    description: result.attested
      ? `Attested by @${actor} at ${head.slice(0, 7)}`
      : `@${actor}, attest this PR — see the comment below`,
    target_url: link,
  });

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
      headRef: pr.head.ref,
      title: pr.title,
      attested: result.attested,
      // The query API reports whether the current head is attested, not
      // when — this run's own clock is the best available answer to "when
      // was this recorded" until the service returns a real timestamp.
      ...(result.attested ? { recordedAt: formatUtc(new Date()) } : {}),
      ...(result.statementSha256 !== null ? { statementSha256: result.statementSha256 } : {}),
    }),
  );

  if (existing === null) {
    await client.createComment(owner, repo, prNumber, body);
  } else {
    await client.updateComment(owner, repo, existing.id, body);
  }

  // Posted last, after the comment and status reflect this run's query
  // result, so the visible reaction always matches what's already live.
  if (triggerCommentId !== undefined) {
    await client.addReaction(owner, repo, triggerCommentId, result.attested ? "+1" : "-1");
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
    const verdicts = computeAncestryVerdicts(result.attestedHeads, head);
    if (verdicts.size > 0) {
      await postAncestry({ service, repo: `${owner}/${repo}`, pr: prNumber, actor, verdicts }, fetchImpl, acktToken);
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
