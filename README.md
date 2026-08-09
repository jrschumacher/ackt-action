# ackt author attestation — GitHub Action

Posts the ackt attest link on a pull request and asks the ackt service
whether the PR author has attested the current head SHA, then posts the
result as the `ackt / human-review` status check. No GitHub App, no
webhooks, no secrets beyond the default workflow token — see
[`docs/superpowers/specs/2026-08-08-no-app-design.md`](../docs/superpowers/specs/2026-08-08-no-app-design.md)
for why.

Adopting ackt in a repo is *only* adding a workflow file — see
[`../ROADMAP.md`](../ROADMAP.md).

## Usage

```yaml
# .github/workflows/ackt.yml
name: ackt author attestation

on:
  pull_request:
    types: [opened, reopened, synchronize]
  issue_comment:
    types: [created, edited]

permissions:
  contents: read # required by actions/checkout
  statuses: write
  pull-requests: write
  issues: write

jobs:
  ackt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aboldnewlook/human-reviewer-attestation/action@main
```

Both triggers are required — see "Triggers" below for why.

## Inputs

| Input | Default | Description |
|---|---|---|
| `service` | `https://ackt.dev` | Base URL of the ackt service to query and link to. This repo's own [`.github/workflows/ackt.yml`](../.github/workflows/ackt.yml) overrides this to the live preview deployment (`https://ackt-preview.j-r-schumacher.workers.dev`) because `ackt.dev` isn't live yet — see the comment there. |
| `fail-on-unattested` | `false` | When `true`, the job fails if the PR author hasn't attested the current head. Leave this `false` unless you specifically want the job's own pass/fail (rather than the status check) to gate something — most consumers, including policy-bot, should read the `ackt / human-review` status check instead, not this job's outcome. |
| `github-token` | `${{ github.token }}` | Token used to read the PR, post the comment, post the status, and add reactions. The default workflow token is sufficient. |

## Outputs

| Output | Description |
|---|---|
| `acted` | `"true"`/`"false"` — whether this run recognized a trigger at all. Most `issue_comment` events are not (see below); this lets you tell "ran and found nothing to do" apart from "did the whole flow." |
| `attested` | `"true"`/`"false"` — whether the PR author has attested the current head. Only set when `acted` is `"true"`. |

## What each trigger does

**`pull_request`** (`opened`, `reopened`, `synchronize`): resolve the PR's real author and head SHA from the GitHub API (never the event payload, which is stale on `synchronize`), query the ackt service, post or update the tracking comment, and post the `ackt / human-review` status.

**`issue_comment`** (`created`, `edited`): this event fires for every comment on every issue *and* pull request in the repo, so most of them are not ackt's concern. A run only proceeds when:

- the comment is on a pull request (guarded via `issue.pull_request`), **and**
- either a brand-new comment starts a line with `/ackt`, or an edited comment's `- [ ] Re-check attestation` checkbox just went from unchecked to checked.

Everything else exits silently (`acted: "false"`) — this event is noisy and must not spam.

When it does proceed: react 👀 on the triggering comment, query the service, post the status, react 👍 or 👎 with the result (GitHub's reaction API has no checkmark/x-mark type — see `src/github.ts`), update the tracking comment, and reset its checkbox to `- [ ]` so it can be toggled again.

The Action refuses to act on a comment authored by `github-actions[bot]` — its own posts and edits — which is what stops the checkbox-reset from re-triggering itself in a loop.

### `issue_comment` runs the default branch's workflow

`issue_comment` (and other non-`pull_request`) workflows always run using the workflow file **on the repository's default branch**, never the PR's own copy. A pull request cannot modify the checker that's about to grade it — this is a GitHub platform property, not something this Action enforces itself, and it's part of why `issue_comment` carries the trigger's forgeability floor even though the Action posts its own status via `GITHUB_TOKEN` (see the design doc's "forgeability trade" section).

## The query

```
GET {service}/api/v1/ackt?repo=<owner/name>&pr=<n>&actor=<PR author>&head=<PR head sha>
→ { "attested": true, "statement_sha256": "..." } | { "attested": false }
```

`actor` and `head` always come from `GET /repos/{owner}/{repo}/pulls/{n}`, never the webhook payload.

## Development

```
pnpm install
pnpm typecheck
pnpm test
pnpm build   # emits dist/*.js — commit the result
```

Zero runtime dependencies, no bundler: the action imports nothing at
runtime beyond Node and global `fetch`, so plain `tsc` output is a valid
Node action entry point. `dist/` is committed; CI does not rebuild it.
