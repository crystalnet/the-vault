// Condenses a Claude Code transcript (JSONL) into a plain conversation for distillation:
// only user prompts and assistant prose; tool calls, tool output and thinking are dropped.
import { readFileSync } from 'node:fs';

const MAX_MESSAGE_CHARS = 6000;

/** Strips harness-injected markup (system reminders, slash-command wrappers) from user text. */
function cleanUserText(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, '')
    .replace(/<bash-(input|stdout|stderr)>[\s\S]*?<\/bash-\1>/g, '') // "!" shell commands and their output
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '') // background task results
    .replace(/<command-(message|args)>[\s\S]*?<\/command-\1>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .trim();
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

function clip(text) {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)} […]` : text;
}

/**
 * Parses transcript lines from `fromLine` on.
 * Returns { text, userTurns, lineCount } where lineCount is the new offset to persist.
 */
export function condenseTranscript(raw, { fromLine = 0, maxChars = 200000 } = {}) {
  const lines = raw.split('\n').filter((l) => l.trim());
  const parts = [];
  let userTurns = 0;

  for (const line of lines.slice(fromLine)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isSidechain || entry.isMeta) continue; // subagent traffic and harness meta messages

    if (entry.type === 'user') {
      const text = cleanUserText(textBlocks(entry.message?.content));
      if (!text) continue; // e.g. pure tool_result messages
      if (entry.isCompactSummary) {
        parts.push(`[EARLIER CONTEXT SUMMARY]\n${clip(text)}`);
      } else {
        parts.push(`USER: ${clip(text)}`);
        userTurns++;
      }
    } else if (entry.type === 'assistant') {
      const text = textBlocks(entry.message?.content).trim();
      if (text) parts.push(`ASSISTANT: ${clip(text)}`);
    }
  }

  let text = parts.join('\n\n');
  if (text.length > maxChars) {
    // Keep the opening (intent) and the larger tail (conclusions) of long sessions.
    const head = Math.floor(maxChars * 0.2);
    text = `${text.slice(0, head)}\n\n[… middle of session omitted …]\n\n${text.slice(text.length - (maxChars - head))}`;
  }
  return { text, userTurns, lineCount: lines.length };
}

export function condenseTranscriptFile(path, options) {
  return condenseTranscript(readFileSync(path, 'utf8'), options);
}
