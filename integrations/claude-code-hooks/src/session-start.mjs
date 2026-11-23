#!/usr/bin/env node
// SessionStart hook: tells the session its Vault project and injects a compact project briefing.
// Fires on startup, resume, /clear and after compaction, so the context is restored whenever it is lost.
import { loadConfig, resolveProject, log, readStdinJson } from './config.mjs';
import { withVault } from './vault-client.mjs';

const CATEGORIES = [
  ['promoted_decisions', 'Key decisions'],
  ['active_plans', 'Active plans'],
  ['recent_handoffs', 'Recent handoffs'],
  ['recent_summaries', 'Recent session summaries'],
  ['promoted_items', 'Promoted items'],
  ['proactive_context', 'Related context'],
];

/** Renders the briefing as Markdown, skipping duplicates across categories and capping the length. */
export function formatBriefing(briefing, maxChars) {
  const seen = new Set();
  const sections = [];
  for (const [key, heading] of CATEGORIES) {
    const lines = (briefing?.[key] ?? [])
      .filter((item) => !seen.has(item.item_uid) && seen.add(item.item_uid))
      .map((item) => `- [${item.memory_type}] ${item.title} (${item.created_at?.slice(0, 10)}, ${item.item_uid}): ${item.summary}`);
    if (lines.length) sections.push(`### ${heading}\n${lines.join('\n')}`);
  }
  const text = sections.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated; use vault_recall_context for more)` : text;
}

async function main() {
  if (process.env.VAULT_HOOKS_CHILD) return; // the distillation run must not trigger hooks itself
  const started = Date.now();
  const config = loadConfig();
  const input = await readStdinJson();
  const target = resolveProject(config, input.cwd || process.cwd());
  if (!target) {
    log(config, 'start', `no project mapped for ${input.cwd}; nothing injected`);
    return;
  }

  let body;
  try {
    const briefing = await withVault(config, (call) =>
      call('vault_get_project_briefing', { project: target.project, limit: config.briefing.limit }));
    body = formatBriefing(briefing, config.briefing.maxChars) || '_No saved knowledge for this project yet._';
  } catch (err) {
    body = `_Briefing unavailable: ${err.message}_`;
    log(config, 'start', `briefing failed for ${target.project}: ${err.message}`);
  }

  const tagNote = target.tags.length ? ` Tag saves with: ${target.tags.join(', ')}.` : '';
  const context = [
    '## Vault',
    `Vault project for this session: **${target.project}**. Recall from and save to this project.${tagNote}`,
    '',
    body,
  ].join('\n');

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  log(config, 'start', `${input.source ?? '?'} ${target.project} session=${input.session_id} ${Date.now() - started}ms`);
}

// Only run when executed directly (tests import formatBriefing).
if (process.argv[1]?.endsWith('session-start.mjs')) {
  // Exit explicitly: never block a session start, even if a handle is left open.
  main().catch(() => {}).finally(() => process.exit(0));
}
