/**
 * Thin REST I/O over `fetch` — no `@octokit/rest`, no `@actions/github`, no
 * bundler needed. Every method is a single HTTP call; nothing is retried,
 * and comment listing goes one page deep (100, ample for a PR thread).
 *
 * This is the part unit tests don't reach directly (see index.ts's doc
 * comment for why that line is drawn here) — the logic worth testing
 * (rendering, trigger decisions, URL construction, response parsing) lives
 * in comment.ts, trigger.ts, and query.ts instead, all of which this module
 * is a thin, mechanical consumer of.
 */

import type { GithubComment } from "./comment.js";

const DEFAULT_API_URL = "https://api.github.com";

export interface PullRequestInfo {
  readonly number: number;
  readonly title: string;
  readonly head: { readonly sha: string; readonly ref: string };
  readonly user: { readonly login: string };
}

export type StatusState = "success" | "pending" | "failure" | "error";

export interface StatusInput {
  readonly state: StatusState;
  readonly context: string;
  readonly description: string;
  readonly target_url: string;
}

export type ReactionContent = "eyes" | "+1" | "-1";

export class GithubClient {
  constructor(
    private readonly token: string,
    private readonly apiUrl: string = DEFAULT_API_URL,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GitHub API ${method} ${path} -> ${response.status}: ${text}`);
    }
    return response;
  }

  /** Always the source of truth for author and head — never the event payload, which is stale on `synchronize` and has no head at all on `issue_comment`. */
  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo> {
    const response = await this.request("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
    return (await response.json()) as PullRequestInfo;
  }

  /** PRs and issues share the same comments endpoint on GitHub's REST API. */
  async listComments(owner: string, repo: string, issueNumber: number): Promise<GithubComment[]> {
    const response = await this.request("GET", `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
    return (await response.json()) as GithubComment[];
  }

  async createComment(owner: string, repo: string, issueNumber: number, body: string): Promise<{ id: number }> {
    const response = await this.request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
    return (await response.json()) as { id: number };
  }

  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    await this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  }

  async createStatus(owner: string, repo: string, sha: string, status: StatusInput): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/statuses/${sha}`, status);
  }

  /** GitHub's reaction API has no checkmark/x-mark content type — see index.ts's call sites for how +1/-1 stand in for "attested"/"not attested". */
  async addReaction(owner: string, repo: string, commentId: number, content: ReactionContent): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, { content });
  }
}
