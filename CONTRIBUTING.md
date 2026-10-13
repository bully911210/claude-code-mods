# Contributing

Bug reports, ideas and pull requests are welcome. Use the issue forms for bugs and ideas.

## Set up

You need a Claude Code build that supports function-hook plugins (CI uses 2.1.295).

```bash
git clone https://github.com/bully911210/claude-code-mods
cd claude-code-mods
claude plugin validate token-ledger
claude plugin test token-ledger
```

To run your working copy, point `CLAUDE_CODE_PLUGIN_DIRS` at the mod folders (see the README), then fully quit and reopen Claude. Plugin folders load only at session start.

## Rules for changes

- Each mod is self-contained: `hooks/register.tsx` (or `.ts`) plus `hooks/lib/` for pure helpers that tests can cover directly.
- Add or update tests in the mod's `tests/` folder. CI runs `claude plugin validate` and `claude plugin test` for every mod on Linux, so avoid Windows-only paths in fixtures.
- Keep control characters (such as `\u0000`) out of string literals in UI hook code. Catalogue scanners flag them.
- If you change what a mod reads, runs, writes or sends, update [SECURITY.md](SECURITY.md).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`.

## Redrawing the README pictures

The SVGs in `docs/img/` are rendered from the element trees the mods really return:

1. Copy `docs/capture/<mod>.capture.ts` into that mod's `tests/` folder.
2. Run `claude plugin test <mod>` and save the lines that start with `CAPTURE ` (without the prefix) to `docs/capture/<mod>.jsonl`.
3. Delete the copied capture test, then run `python docs/tools/render.py`.

The demo page (`docs/index.html`) reads the same JSONL files.
