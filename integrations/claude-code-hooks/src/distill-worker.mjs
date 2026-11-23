#!/usr/bin/env node
// Detached worker: condenses the new part of a transcript, asks a headless Claude run what is worth
// keeping (structured output), and saves the result to the Vault. Code decides THAT it runs;
// the model only decides WHAT to save.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, log, STATE_DIR } from './config.mjs';
import { condenseTranscriptFile } from './transcript.mjs';
import { withVault } from './vault-client.mjs';

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'distill-prompt.md');
const LOCK_STALE_MS = 15 * 60 * 1000;

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          memory_type: { enum: ['decision', 'plan', 'handoff', 'summary'] },
          title: { type: 'string' },
          subject: { type: 'string' },
          summary: { type: 'string' },
          content: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          next_steps: { type: 'array', items: { type: 'string' } },
          priority: { enum: ['normal', 'high'] },
          routine_type: { enum: ['debugging', 'planning', 'implementation', 'review', 'testing', 'brainstorming', 'refactor', 'deployment'] },
        },
        required: ['memory_type', 'title', 'subject', 'summary', 'content', 'keywords'],
      },
    },
  },
  required: ['items'],
};

/** One distillation per session at a time (SessionEnd and PreCompact can overlap). */
function acquireLock(path) {
  try {
    closeSync(openSync(path, 'wx'));
    return true;
  } catch {
    if (Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS) return false;
    unlinkSync(path); // stale lock from a crashed worker
    return acquireLock(path);
  }
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { offset: 0 }; }
}

function runClaude({ model, claudeCommand = 'claude' }, prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', model, '--restricted', '--strict-mcp-config', '--tools', '',
      '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(ITEM_SCHEMA)];
    const child = spawn(claudeCommand, args, { cwd: STATE_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const result = JSON.parse(out);
        if (result.is_error || !result.structured_output) throw new Error(result.result || 'no structured output');
        resolve({ items: result.structured_output.items ?? [], cost: result.total_cost_usd });
      } catch (e) {
        reject(new Error(`claude exited ${code}: ${e.message} ${err.slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

function buildPrompt(job, existing, transcript) {
  const known = existing.length
    ? existing.map((i) => `- [${i.memory_type}] ${i.title} (subject: ${i.subject}): ${i.summary}`).join('\n')
    : '(none yet)';
  return [
    readFileSync(PROMPT_PATH, 'utf8'),
    `## Project\n${job.project}`,
    `## Existing items in this project (most recent first)\n${known}`,
    `## Transcript\n${transcript}`,
  ].join('\n\n');
}

async function main() {
  const job = JSON.parse(process.argv[2]);
  const config = loadConfig();
  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = join(STATE_DIR, `${job.sessionId}.json`);
  const lockPath = `${statePath}.lock`;
  if (!acquireLock(lockPath)) {
    log(config, 'distill', `${job.sessionId}: another distillation is running; skipped`);
    return;
  }

  try {
    const state = readState(statePath);
    const { text, userTurns, lineCount } = condenseTranscriptFile(job.transcriptPath, {
      fromLine: state.offset, maxChars: config.distill.maxTranscriptChars,
    });
    // Too little new conversation: keep the offset so it accumulates with the next run.
    if (userTurns < config.distill.minExchanges) {
      log(config, 'distill', `${job.event} ${job.project} ${job.sessionId}: ${userTurns} new user turns < ${config.distill.minExchanges}; skipped`);
      return;
    }

    const saved = await withVault(config, async (call) => {
      const latest = await call('vault_get_latest', { project: job.project, limit: 15 });
      const { items, cost } = await runClaude(config.distill, buildPrompt(job, latest.items ?? [], text));
      const uids = [];
      for (const item of items) {
        const res = await call('vault_save_memory', {
          ...item,
          project: job.project,
          tags: [...config.distill.tags, ...job.tags],
          source_app: 'claude',
          source_session_id: job.sessionId,
          status: 'active',
        });
        uids.push(`${item.memory_type}:${res.item_uid ?? res.item?.item_uid ?? '?'} "${item.title}"`);
      }
      return { uids, cost };
    }, { timeoutMs: 30000 });

    writeFileSync(statePath, JSON.stringify({ offset: lineCount, updatedAt: new Date().toISOString() }));
    log(config, 'distill', `${job.event} ${job.project} ${job.sessionId}: saved ${saved.uids.length} (cost $${saved.cost?.toFixed(3)}) ${saved.uids.join('; ')}`);
  } catch (err) {
    log(config, 'distill', `${job.event} ${job.project} ${job.sessionId}: FAILED ${err.message}`);
  } finally {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

main().finally(() => process.exit(0));
