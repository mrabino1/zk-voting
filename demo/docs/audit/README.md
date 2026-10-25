# Audits

This folder holds security reviews of the zk-voting codebase. Reports are grouped by component, and each file is named `YYYY-MM-DD-<Component>-Audit-<Reviewer>.md`.

> Automated and AI-assisted reviews are **not** a substitute for an audit by a professional security firm. Each report states its own commit, scope and limits.

## Smart contracts (`smart-contracts/`)

| Date | Commit | Reviewer | Report | Summary |
|---|---|---|---|---|
| 2026-10-24 | `b1cef6f7` | GrokBot (automated + AI-assisted) | [2026-10-24-SmartContract-Audit-GrokBot.md](smart-contracts/2026-10-24-SmartContract-Audit-GrokBot.md) | 2 Critical, 6 High, 8 Medium, 10 Low, 6 Info |

## Adding a report

1. Put it in `docs/audit/<component>/` using the naming pattern above.
2. State the exact commit SHA, scope, tools and versions, and the disclaimer.
3. Add a row to the table above.
