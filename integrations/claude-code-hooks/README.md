# Claude Code hooks for the Vault

Makes Vault usage automatic instead of relying on the skill:

| Hook | What happens |
|---|---|
| `SessionStart` (startup, resume, `/clear`, after compaction) | Maps the working folder to a Vault project and injects "Vault project for this session: X" plus a compact project briefing. |
| `SessionEnd`, `PreCompact` | Starts a detached worker that condenses the new part of the transcript, asks a headless `claude -p` run (structured output) what is worth keeping, and saves decisions / plans / handoffs / a session summary to the Vault. |

Code decides *that* distillation runs; the model decides *what* is saved (`distill-prompt.md`).

## Install

```bash
node integrations/claude-code-hooks/install.mjs     # --uninstall to remove
```

- Links `~/.claude/hooks/vault/src` to this folder, so edits here take effect immediately.
- Creates `~/.claude/hooks/vault/config.json`: add folder → project mappings under `projects`
  (longest path prefix wins; optional `tags` per entry). Unmapped folders are left alone.
- Registers the hooks in `~/.claude/settings.json` (a timestamped backup is written first).

Requires the `vault-memory` MCP runtime (`mcp-standalone/`) built for the Node that runs the hooks.

## Behaviour

- Saved items get the `auto` tag plus the folder's tags, `source_session_id`, and status `active`.
- Sessions with fewer than `minExchanges` new user turns are skipped; the content is picked up by
  the next run. Per-session offsets in `~/.claude/hooks/vault/state/` prevent double distillation
  on resume or after `PreCompact`.
- The worker sets `VAULT_HOOKS_CHILD=1` and runs `claude -p --restricted`, so it never triggers the
  hooks itself.
- Everything is logged to `logFile` (default `~/Vault/logs/claude-code-hooks.log`), including the
  cost of each distillation.

## Test

```bash
node --test integrations/claude-code-hooks/src/hooks.test.mjs
```
