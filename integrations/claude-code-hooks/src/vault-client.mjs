// Minimal MCP stdio client for the vault-memory server: spawn, initialize, call tools, shut down.
// Uses the same tool path as agents, so the Vault's validation and logging apply unchanged.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function withVault(config, fn, { timeoutMs = 20000 } = {}) {
  const { command, args = [] } = config.vaultServer;
  const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let nextId = 1;

  createInterface({ input: server.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const exited = new Promise((_, reject) => {
    server.on('error', reject);
    server.on('exit', (code) => reject(new Error(`vault server exited (code ${code})`)));
  });

  const send = (method, params) => {
    const id = nextId++;
    const reply = new Promise((resolve) => pending.set(id, resolve));
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`vault ${method} timed out`)), timeoutMs).unref());
    return Promise.race([reply, timeout, exited]);
  };

  /** Calls a tool and returns its parsed JSON payload; throws on tool or protocol errors. */
  const call = async (name, args) => {
    const res = await send('tools/call', { name, arguments: args });
    const text = (res.result?.content ?? []).map((c) => c.text).join('');
    if (res.error || res.result?.isError) throw new Error(`${name}: ${res.error ? JSON.stringify(res.error) : text}`);
    try { return JSON.parse(text); } catch { return text; }
  };

  try {
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vault-claude-code-hooks', version: '1' } });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return await fn(call);
  } finally {
    // Close our end of every pipe so neither side keeps the other's event loop alive.
    server.removeAllListeners('exit');
    server.stdin.end();
    server.stdout.destroy();
    server.kill();
    server.unref();
  }
}
