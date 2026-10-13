# Security

## Reporting a problem

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/bully911210/claude-code-mods/security/advisories/new) rather than a public issue.

## What each mod can access

Every mod runs inside Claude Code through its function-hook API. None of them makes network requests of its own. The model calls below go through Claude Code's own API connection.

| | token-ledger | next-steps | auto-docs |
| --- | --- | --- | --- |
| **Reads** | Session usage and rate limits, session messages, model id, project root, CLAUDE.md files above the project, prompt box text, subagent list | Session messages, project root, prompt box text | The commit's message, file list and diff (through git), the doc files you list |
| **Runs** | `git` (read-only: branch, status, recent log), 10-second timeout | Nothing | `git` (rev-parse, log, show, add, commit) |
| **Writes** | Its own plugin store; the prompt box when you press Insert | The prompt box when you press Insert | The doc files you list, and one `docs:` commit per sync. It never pushes. |
| **Model calls** | Haiku 5.5, only when you press `?` or run `/ask` | Haiku (or Sonnet, if configured) after a real turn | Sonnet (configurable) once per commit |

Nothing is ever submitted from the prompt box: insert puts text there and stops.

next-steps replaces ID numbers, phone numbers, email addresses and card numbers with stable tokens before any text leaves for the model, including file and project names.
