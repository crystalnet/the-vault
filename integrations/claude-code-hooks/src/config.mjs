// Loads the user's hook config and resolves which Vault project a working directory belongs to.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export const HOOK_HOME = process.env.VAULT_HOOKS_HOME || join(homedir(), '.claude', 'hooks', 'vault');
export const STATE_DIR = join(HOOK_HOME, 'state');

/** Expands a leading "~" to the home directory and normalises the path. */
export function expandHome(p) {
  if (!p) return p;
  return resolve(p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);
}

export function loadConfig(path = join(HOOK_HOME, 'config.json')) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  return {
    ...config,
    projects: config.projects ?? [],
    briefing: { limit: 5, maxChars: 6000, ...config.briefing },
    distill: { model: 'sonnet', minExchanges: 3, tags: ['auto'], maxTranscriptChars: 200000, ...config.distill },
    logFile: expandHome(config.logFile ?? join(HOOK_HOME, 'hooks.log')),
  };
}

/**
 * Maps a working directory to { project, tags } using the longest matching path prefix,
 * so ~/Projects/lawyeah-agents wins over a broader ~/Projects entry. Returns null if unmapped.
 */
export function resolveProject(config, cwd) {
  if (!cwd) return null;
  const dir = expandHome(cwd);
  let best = null;
  for (const entry of config.projects) {
    for (const raw of entry.paths ?? []) {
      const root = expandHome(raw);
      const matches = dir === root || dir.startsWith(root + sep);
      if (matches && (!best || root.length > best.rootLength)) {
        best = { project: entry.project, tags: entry.tags ?? [], rootLength: root.length };
      }
    }
  }
  return best && { project: best.project, tags: best.tags };
}

/** Appends one line to the hook log. Logging must never break a hook, so errors are swallowed. */
export function log(config, event, message) {
  try {
    mkdirSync(dirname(config.logFile), { recursive: true });
    appendFileSync(config.logFile, `${new Date().toISOString()} [${event}] ${message}\n`);
  } catch {
    // ignore
  }
}

/** Reads the hook input JSON that Claude Code sends on stdin. */
export async function readStdinJson() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() ? JSON.parse(data) : {};
}
