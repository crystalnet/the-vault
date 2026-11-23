// Run with: node --test integrations/claude-code-hooks/src/hooks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveProject } from './config.mjs';
import { condenseTranscript } from './transcript.mjs';
import { formatBriefing } from './session-start.mjs';

const config = {
  projects: [
    { project: 'app', paths: ['~/Projects/app'] },
    { project: 'app', paths: ['~/Projects/app-agents'], tags: ['area:agents'] },
    { project: 'wide', paths: ['~/Projects'] },
  ],
};

test('resolveProject picks the longest matching prefix and respects path boundaries', () => {
  const p = (rel) => join(homedir(), 'Projects', rel);
  assert.deepEqual(resolveProject(config, p('app/src')), { project: 'app', tags: [] });
  assert.deepEqual(resolveProject(config, p('app-agents')), { project: 'app', tags: ['area:agents'] });
  assert.deepEqual(resolveProject(config, p('other')), { project: 'wide', tags: [] });
  assert.equal(resolveProject(config, '/etc'), null);
});

const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');

test('condenseTranscript keeps prose, drops tools/thinking/sidechains/reminders, counts user turns', () => {
  const raw = jsonl(
    { type: 'user', message: { content: 'hello <system-reminder>noise</system-reminder>' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hi there' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }] } },
    { type: 'user', isSidechain: true, message: { content: 'subagent prompt' } },
    { type: 'user', isCompactSummary: true, message: { content: 'summary so far' } },
    { type: 'attachment' },
    { type: 'user', message: { content: 'second question' } },
    { type: 'user', message: { content: '<bash-input>rm -rf x</bash-input>' } },
    { type: 'user', message: { content: '<task-notification><summary>done</summary></task-notification>' } },
  );
  const { text, userTurns, lineCount } = condenseTranscript(raw);
  assert.equal(userTurns, 2);
  assert.equal(lineCount, 10);
  assert.match(text, /USER: hello$/m);
  assert.match(text, /ASSISTANT: hi there/);
  assert.match(text, /\[EARLIER CONTEXT SUMMARY\]/);
  assert.doesNotMatch(text, /noise|subagent|tool_result|out\b/);
});

test('condenseTranscript only reads lines after the offset', () => {
  const raw = jsonl({ type: 'user', message: { content: 'old' } }, { type: 'user', message: { content: 'new' } });
  const { text, userTurns } = condenseTranscript(raw, { fromLine: 1 });
  assert.equal(userTurns, 1);
  assert.equal(text, 'USER: new');
});

test('formatBriefing dedupes across categories and handles empty briefings', () => {
  const item = { item_uid: 'u1', memory_type: 'decision', title: 'T', created_at: '2026-01-02T00:00:00Z', summary: 'S' };
  const out = formatBriefing({ promoted_decisions: [item], promoted_items: [item] }, 1000);
  assert.equal(out.match(/u1/g).length, 1);
  assert.equal(formatBriefing({}, 1000), '');
});
