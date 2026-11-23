#!/usr/bin/env node
// Installs the hooks for the current user:
//   1. links ~/.claude/hooks/vault/src -> this repo's src (repo edits take effect immediately)
//   2. creates ~/.claude/hooks/vault/config.json from the example if missing
//   3. registers SessionStart / SessionEnd / PreCompact in ~/.claude/settings.json (backup first)
// Usage: node install.mjs [--uninstall]
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const hookHome = join(homedir(), '.claude', 'hooks', 'vault');
const linkPath = join(hookHome, 'src');
const settingsPath = join(homedir(), '.claude', 'settings.json');
const uninstall = process.argv.includes('--uninstall');

const node = process.execPath;
const cmd = (script) => `"${node}" "${join(linkPath, script)}"`;
const HOOKS = {
  SessionStart: { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: cmd('session-start.mjs'), timeout: 15 }] },
  SessionEnd: { hooks: [{ type: 'command', command: cmd('session-end.mjs'), timeout: 10 }] },
  PreCompact: { hooks: [{ type: 'command', command: cmd('session-end.mjs'), timeout: 10 }] },
};
const isOurs = (group) => group.hooks?.some((h) => h.command?.includes(linkPath));

// --- settings.json: remove previous entries of ours, then (re)add -----------------------------
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (existsSync(settingsPath)) copyFileSync(settingsPath, backup);
settings.hooks ??= {};
for (const event of Object.keys(HOOKS)) {
  settings.hooks[event] = (settings.hooks[event] ?? []).filter((g) => !isOurs(g));
  if (!uninstall) settings.hooks[event].push(HOOKS[event]);
  if (!settings.hooks[event].length) delete settings.hooks[event];
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

if (uninstall) {
  if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
  console.log(`Removed hooks from ${settingsPath} (backup: ${backup}). Config and state kept in ${hookHome}.`);
  process.exit(0);
}

// --- link the code ------------------------------------------------------------------------------
mkdirSync(join(hookHome, 'state'), { recursive: true });
try { if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath); } catch { /* not there yet */ }
symlinkSync(join(here, 'src'), linkPath);

// --- config ---------------------------------------------------------------------------------------
const configPath = join(hookHome, 'config.json');
if (!existsSync(configPath)) {
  const config = JSON.parse(readFileSync(join(here, 'config.example.json'), 'utf8'));
  config.vaultServer = { command: node, args: [join(repoRoot, 'mcp-standalone', 'dist', 'index.js')] };
  try { config.distill.claudeCommand = execFileSync('which', ['claude']).toString().trim(); } catch { /* keep default */ }
  config.projects = [];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`Created ${configPath}: add your folder -> project mappings under "projects".`);
}

console.log(`Installed. Code: ${linkPath} -> ${join(here, 'src')}. Settings backup: ${backup}`);
