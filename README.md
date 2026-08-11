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
  id-token: write # required — see "The OIDC token" below
  statuses: write
  pull-requests: write
  issues: write

jobs:
  ackt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # required — full history, so ancestry can be checked
      - uses: aboldnewlook/human-reviewer-attestation/action@main
```

Both triggers are required — see "Triggers" below for why.

Both `id-token: write` and `fetch-depth: 0` are required. The action fails
the step without the first; the second it needs to answer ancestry
questions about heads attested before the current one. Neither is a
default, so copy the block above rather than assembling it.

## The OIDC token

The action authenticates to the ackt service with a **GitHub Actions OIDC
token**, minted per run by the runner and audienced to `ackt.dev`. Its
signed claims carry the repository, its id, and its visibility — facts the
service cannot take from a query parameter, because anyone can type one.

That token is what lets the service answer for a **private** repository,
and what lets it record the check for the ackt dashboard.

The runner only exposes the minting endpoint when the workflow grants
`permissions: id-token: write`. Without it the action **fails the step**
with a message naming the permission and the workflow file — it does not
fall back to an unauthenticated request. A silent fallback would still go
green and still answer for public repos, so the only symptom would be a
dashboard that never populates and nothing in the log to explain why.

Granting `id-token: write` lets *this* workflow mint identity tokens for
any audience; it grants nothing about the repository's contents, and it is
independent of the `GITHUB_TOKEN` permissions above.

## Full history

`actions/checkout` clones a single commit by default. ackt needs the pull
request's real history to decide whether a head attested earlier is still
an ancestor of the current head — a rebase or force-push removes it, and
`git merge-base --is-ancestor` is the only thing that can tell those apart.
`fetch-depth: 0` is what makes that answerable.

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
Authorization: Bearer <GitHub Actions OIDC token, audience ackt.dev>

→ { "attested": true, "statement_sha256": "...", "attested_heads": ["..."] }
| { "attested": false, "attested_heads": [] }
```

`actor` and `head` always come from `GET /repos/{owner}/{repo}/pulls/{n}`, never the webhook payload.

`attested_heads` lists every head this actor has attested on this pull
request, oldest first. The service can say *which* heads were attested; only
git can say whether they are still in this history, which is why the answer
comes back to the runner rather than being decided server-side.

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
