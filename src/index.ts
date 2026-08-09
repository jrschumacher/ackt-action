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

import { attestUrl, findAcktComment, formatUtc, renderComment, resetCheckbox } from "./comment.js";
import { GithubClient } from "./github.js";
import { queryAckt, type FetchLike } from "./query.js";
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

const fetchImpl: FetchLike = (url) => fetch(url);

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

  const result = await queryAckt({ service, repo: `${owner}/${repo}`, pr: prNumber, actor, head }, fetchImpl);

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

  setOutput("attested", String(result.attested));

  if (failOnUnattested && !result.attested) {
    console.error("::error::fail-on-unattested is true and the PR author has not attested the current head.");
    process.exitCode = 1;
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
