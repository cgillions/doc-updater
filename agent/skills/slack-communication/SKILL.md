---
description: Use before writing any Slack-facing repository documentation review message, approval note, completion report, drift alert, or no-change summary.
---

# Slack Communication

Use this skill for every message that will be posted to Slack.

This skill drafts Slack-facing content. Loading it does not send a message,
select a Slack destination, create a thread, or perform a workflow transition.
The Slack channel owns delivery and thread binding.

## Style

- Be warm, concise, and teammate-facing.
- Start with a friendly greeting similar to "Hey team, I spotted something that needs to be updated" or "Good job guys, the docs for repo <repo-url|repo-name> are all in sync".
- Use Slack emoji shortcodes where they help the reader understand motive quickly.
- Prefer plain English over audit language. Write for maintainers, not for logs.
- Keep confidence bounded. Say what was checked and what needs action concisely, without overstating proof.

## Privacy And Noise Control

Do not include internal identifiers in Slack-facing text:

- no review job IDs, session IDs, run IDs, lease IDs, continuation tokens, digests, raw SHAs, or opaque candidate IDs;
- no internal database or control-plane identifiers;
- no implementation details that only help debugging the agent.

Use human-recognizable references instead:

- repository link, formatted for Slack API `mrkdwn` as `<repo-url|repo-name>`;
- documentation path or page title;
- pull request link or approval action when one exists;
- short behaviour summary.

If the repository URL is unavailable, do not invent one. Use the repository name plainly and keep the rest of the format.

## Message Format

Use this consistent structure. Do not include a long list of what you checked if it does not add value.

```text
Hey team, <friendly opener> <emoji>

Repo: <repo-url|repo-name>
Status: <plain-language outcome>

What I checked:
- <one short evidence-backed point>
- <one short evidence-backed point>

Next step:
<one clear action, or "No action needed.">
```

For very small updates, keep the same order but collapse to one short paragraph.

## Approval Context

Immediately before an approval-gated repository pull request or Confluence
page update, emit this exact envelope and request the gated tool in the same
assistant step:

```text
<slack_approval_context>
Hey team, I found a docs update that needs approval 💬

Summary of change:
<one short sentence explaining what will be created and why>

Evidence checked:
- <one evidence-backed implementation point>
- <one evidence-backed documentation point>
- <optional narrowness or safety point>

I need approval to create a [pull request | publish this page update]. Please review the approval request in this thread.
</slack_approval_context>
```

The envelope tags are an internal delivery marker. The Slack channel removes
them before posting. Never emit this envelope as a standalone terminal
response: it must accompany `create_repository_pull_request` or
`publish_confluence_page_update` in the same assistant step.

## Outcome Patterns

### Documentation Drift Found

```text
Hey team, I spotted something that needs to be updated 👀

Repo: <repo-url|repo-name>
Status: The implementation changed, and the docs no longer match it.

What I checked:
- <behavior that changed>
- <documentation path or page title that is now stale>

Next step:
I have prepared the smallest docs update for review.
```

### In Sync

```text
Good job guys, the docs for repo <repo-url|repo-name> are all in sync :white_check_mark:

Repo: <repo-url|repo-name>
Status: No docs update is needed.

What I checked:
- <behavior reviewed>
- <documentation path or page title that still matches>

Next step:
No action needed.
```

### Needs Human Input

```text
Hey team, I need a quick decision before this docs update can move forward 💬

Repo: <repo-url|repo-name>
Status: I found a docs update, but it needs review before publishing.

What I checked:
- <behavior that changed>
- <proposed documentation target>

Next step:
Please approve or reject the proposed docs update.
```

### Incomplete Review

```text
Hey team, I could not safely finish this docs check 👀

Repo: <repo-url|repo-name>
Status: I did not have enough evidence to decide whether the docs are still accurate.

What I checked:
- <evidence that was available>
- <specific missing or unavailable evidence>

Next step:
Someone should review the docs manually before relying on them.
```

### Existing Confluence Draft

```text
Hey team, I found a docs update that needs a decision 💬

Repo: <repo-url|repo-name>
Page: <page-url|page-name>
Status: The page needs the proposed update, but I did not create a draft because an existing draft already exists.

What I checked:
- <the implementation behavior that changed>
- <the page claim that needs updating and the proposed correction>

Next step:
Please reconcile the existing draft with this proposed change. No new draft was created, so existing work is preserved.
```

### Published Confluence Update

```text
Hey team, the approved Confluence update is now published ✅

Repo: <repo-url|repo-name>
Page: <pageUrl|page-name>
Status: Version <publishedVersion> contains the approved documentation update.

What changed:
- <one concise evidence-backed summary of the published correction>

Review:
<historyUrl|Open version history to review the diff>

Next step:
Please compare the latest two versions in Confluence and raise any follow-up in this thread.
```

## Final Check Before Sending

Before sending, verify:

- the message has no raw IDs or SHAs;
- repository references use Slack API `mrkdwn` link syntax when a repository URL is available;
- the tone is friendly and not robotic;
- the status and next step are obvious from a quick scan;
- every factual claim is supported by evidence gathered in the session;
- the message does not expose hidden tool, database, or workflow details.
