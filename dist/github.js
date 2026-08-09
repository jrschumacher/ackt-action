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
const DEFAULT_API_URL = "https://api.github.com";
export class GithubClient {
    token;
    apiUrl;
    constructor(token, apiUrl = DEFAULT_API_URL) {
        this.token = token;
        this.apiUrl = apiUrl;
    }
    async request(method, path, body) {
        const headers = {
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
    async getPullRequest(owner, repo, prNumber) {
        const response = await this.request("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
        return (await response.json());
    }
    /** PRs and issues share the same comments endpoint on GitHub's REST API. */
    async listComments(owner, repo, issueNumber) {
        const response = await this.request("GET", `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
        return (await response.json());
    }
    async createComment(owner, repo, issueNumber, body) {
        const response = await this.request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
        return (await response.json());
    }
    async updateComment(owner, repo, commentId, body) {
        await this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
    }
    async createStatus(owner, repo, sha, status) {
        await this.request("POST", `/repos/${owner}/${repo}/statuses/${sha}`, status);
    }
    /** GitHub's reaction API has no checkmark/x-mark content type — see index.ts's call sites for how +1/-1 stand in for "attested"/"not attested". */
    async addReaction(owner, repo, commentId, content) {
        await this.request("POST", `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, { content });
    }
}
