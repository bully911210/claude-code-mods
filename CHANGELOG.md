# Changelog

Each mod is versioned on its own (the `version` in its `.claude-plugin/plugin.json`). Dates are UTC.

## 2026-10-13

- **auto-docs:** tests now pass on Linux and macOS as well as Windows.
- Repository: CI validates and tests every mod on each push and pull request; issue forms, SECURITY.md and CONTRIBUTING.md added.

## 2026-10-12

- **token-ledger 0.5.0**, **next-steps 0.2.0**: the questions and next-steps panes are multi-select. Rows show `[x]` / `[ ]`, with Select all (`a`), Clear (`c`) and an Insert button that is always shown. The hint says "press 1" when there is one item.
- **next-steps:** the redaction hash uses a printable separator instead of NUL, so catalogue UI scans pass. Tokens are salted per session, so nothing users see changes.
- First public release of **token-ledger 0.5.0**, **next-steps 0.2.0** and **auto-docs 0.1.0**.
