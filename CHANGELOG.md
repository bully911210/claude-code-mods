# Changelog

Each mod is versioned on its own (the `version` in its `.claude-plugin/plugin.json`). Dates are UTC.

## 2026-10-17

- **token-ledger 0.6.0**: `?` now learns from your project and from you.
  - After each turn you type, Haiku folds the exchange into a short per-project brief and a profile of you that carries across projects.
  - Your corrections and frustration, and which suggestions you inserted or skipped, are logged as feedback.
  - `?` reads that memory plus only the latest messages. Until a brief exists it still gets the full chat.
  - New `/brief` command shows what the mod knows and lets you fix it: `/brief brief <text>`, `/brief profile <text>`, `/brief forget`, `/brief reset`.
  - South African ID numbers and phone numbers, emails, card numbers, bank accounts and passport numbers are redacted before anything is stored or sent to Haiku. Names and non-South-African phone or ID formats are not detected. Only prompts a person typed are learned from, never notifications or schedules.
  - The `?` prompt no longer assumes you are a developer.

## 2026-10-13

- **auto-docs:** tests now pass on Linux and macOS as well as Windows.
- Repository: CI validates and tests every mod on each push and pull request; issue forms, SECURITY.md and CONTRIBUTING.md added.

## 2026-10-12

- **token-ledger 0.5.0**, **next-steps 0.2.0**: the questions and next-steps panes are multi-select. Rows show `[x]` / `[ ]`, with Select all (`a`), Clear (`c`) and an Insert button that is always shown. The hint says "press 1" when there is one item.
- **next-steps:** the redaction hash uses a printable separator instead of NUL, so catalogue UI scans pass. Tokens are salted per session, so nothing users see changes.
- First public release of **token-ledger 0.5.0**, **next-steps 0.2.0** and **auto-docs 0.1.0**.
