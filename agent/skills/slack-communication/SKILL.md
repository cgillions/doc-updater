---
description: Use before writing any Slack-facing repository documentation review message, approval note, completion report, drift alert, or no-change summary.
---

# Slack Communication

Use this skill for every message that will be posted to Slack.

## Style

- Be warm, concise, and teammate-facing.
- Start with a friendly greeting similar to "Hey team, I spotted something that needs to be updated" or "Good job guys, the docs for repo <repo-name> are all in sync".
- Use Slack emoji shortcodes where they help scanning: `:eyes:` for review/drift, `:white_check_mark:` for in-sync or complete, `:speech_bubble:` for decisions or human input, etc.
- Prefer plain English over audit language. Write for maintainers, not for logs.
- Keep confidence bounded. Say what was checked and what needs action concisely, without overstating proof.

## Privacy And Noise Control

Do not include internal identifiers in Slack-facing text:

- no review job IDs, session IDs, run IDs, lease IDs, continuation tokens, digests, raw SHAs, or opaque candidate IDs;
- no internal database or control-plane identifiers;
- no implementation details that only help debugging the agent.

Use human-recognizable references instead:

- repository name;
- documentation path or page title;
- pull request link or approval action when one exists;
- short behaviour summary.

## Message Format

Use this consistent structure. Do not include a long list of what you checked if it does not add value.

```text
Hey team, <friendly opener> <emoji>

Repo: <repo-name>
Status: <plain-language outcome>

What I checked:
- <one short evidence-backed point>
- <one short evidence-backed point>

Next step:
<one clear action, or "No action needed.">
```

For very small updates, keep the same order but collapse to one short paragraph.

## Outcome Patterns

### Documentation Drift Found

```text
Hey team, I spotted something that needs to be updated :eyes:

Repo: <repo-name>
Status: The implementation changed, and the docs no longer match it.

What I checked:
- <behavior that changed>
- <documentation path or page title that is now stale>

Next step:
I have prepared the smallest docs update for review.
```

### In Sync

```text
Good job guys, the docs for repo <repo-name> are all in sync :white_check_mark:

Repo: <repo-name>
Status: No docs update is needed.

What I checked:
- <behavior reviewed>
- <documentation path or page title that still matches>

Next step:
No action needed.
```

### Needs Human Input

```text
Hey team, I need a quick decision before this docs update can move forward :speech_bubble:

Repo: <repo-name>
Status: I found a docs update, but it needs review before publishing.

What I checked:
- <behavior that changed>
- <proposed documentation target>

Next step:
Please approve or reject the proposed docs update.
```

### Incomplete Review

```text
Hey team, I could not safely finish this docs check :eyes:

Repo: <repo-name>
Status: I did not have enough evidence to decide whether the docs are still accurate.

What I checked:
- <evidence that was available>
- <specific missing or unavailable evidence>

Next step:
Someone should review the docs manually before relying on them.
```

## Final Check Before Sending

Before sending, verify:

- the message has no raw IDs or SHAs;
- the tone is friendly and not robotic;
- the status and next step are obvious from a quick scan;
- every factual claim is supported by evidence gathered in the session;
- the message does not expose hidden tool, database, or workflow details.
