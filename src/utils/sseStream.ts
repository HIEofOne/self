/**
 * Incremental parser for the chat server's event stream: one
 * `data: <json>\n\n` event per update.
 *
 * Network reads split the stream at arbitrary byte boundaries, so an event
 * can straddle two reads. Each piece must be buffered until its terminating
 * blank line arrives — parsing every read on its own silently drops any
 * event cut in half (the first half fails JSON.parse, the second half does
 * not start with "data: "). Long answers lose more and more text that way,
 * which surfaced as progressively garbled chat replies.
 */
export interface SseParser {
  /** Feed decoded text; returns every event completed by it. */
  push(text: string): unknown[];
  /** End of stream: parse whatever remains (a last event may lack its
   *  trailing blank line). */
  flush(): unknown[];
}

const parseBlock = (block: string): unknown[] => {
  const line = block.replace(/^\n+/, '');
  if (!line.startsWith('data: ')) return [];
  try {
    return [JSON.parse(line.slice(6))];
  } catch {
    return []; // malformed event — skip it, as before
  }
};

export const createSseParser = (): SseParser => {
  let buffer = '';
  return {
    push(text: string) {
      buffer += text;
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      return blocks.flatMap(parseBlock);
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return rest.trim() ? parseBlock(rest) : [];
    }
  };
};
