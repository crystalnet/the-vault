#!/usr/bin/env node
// SessionEnd / PreCompact hook: hands the transcript to a detached distillation worker and returns
// immediately, so closing or compacting a session never waits on the model.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, resolveProject, log, readStdinJson } from './config.mjs';

async function main() {
  if (process.env.VAULT_HOOKS_CHILD) return; // the distillation run must not trigger hooks itself
  const config = loadConfig();
  const input = await readStdinJson();
  const event = input.hook_event_name ?? 'SessionEnd';
  const target = resolveProject(config, input.cwd || process.cwd());
  if (!target) {
    log(config, 'end', `${event}: no project mapped for ${input.cwd}; skipped`);
    return;
  }
  if (!input.transcript_path) {
    log(config, 'end', `${event}: no transcript_path in hook input; skipped`);
    return;
  }

  const job = { event, sessionId: input.session_id, transcriptPath: input.transcript_path, ...target };
  const worker = join(dirname(fileURLToPath(import.meta.url)), 'distill-worker.mjs');
  // detached + ignored stdio: the worker survives the hook (and the Claude Code process) exiting.
  spawn(process.execPath, [worker, JSON.stringify(job)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, VAULT_HOOKS_CHILD: '1' },
  }).unref();
  log(config, 'end', `${event} ${target.project} session=${input.session_id}: worker started`);
}

main().catch(() => {}).finally(() => process.exit(0)); // never block session end or compaction
