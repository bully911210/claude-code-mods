# claude-code-mods

Three Claude Code function-hook mods: token-ledger (plan limits row, `?` button), next-steps (suggested next prompts), auto-docs (README sync after each commit).

Third-party repo (remote `bully911210/claude-code-mods`). Each mod is also its own project in Claudapult.

## Layout
- `token-ledger/`, `next-steps/`, `auto-docs/`: one mod each, with `hooks/`, `tests/`, `tsconfig.json`.
- `README.md`: what each mod does and its commands. Read it first.
- `docs/`: images and the interactive demo.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`.

## Rules
- Change only the mod you were asked about.
- Keep README.md in step with any change to behaviour or commands.
- Push to your own fork or branch, never to the upstream `main`.
