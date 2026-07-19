const THINKING_STREAM_TAG_RE =
  /<\s*(\/?)\s*(?:think(?:ing)?|analysis|thought|antthinking)\s*>/gi;
const THINKING_OPEN_STREAM_TAG_RE =
  /<\s*(?:think(?:ing)?|analysis|thought|antthinking)\s*>/gi;
const THINKING_CLOSE_STREAM_TAG_RE =
  /<\s*\/\s*(?:think(?:ing)?|analysis|thought|antthinking)\s*>/gi;

export function extractThinkingFromTaggedText(text: string): string {
  if (!text) return "";
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  THINKING_STREAM_TAG_RE.lastIndex = 0;
  for (const match of text.matchAll(THINKING_STREAM_TAG_RE)) {
    const idx = match.index ?? 0;
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const isClose = match[1] === "/";
    inThinking = !isClose;
    lastIndex = idx + match[0].length;
  }
  return result.trim();
}

export function hasUnclosedThinkingTag(text: string): boolean {
  if (!text) return false;
  const openMatches = [...text.matchAll(THINKING_OPEN_STREAM_TAG_RE)];
  if (openMatches.length === 0) return false;
  const closeMatches = [...text.matchAll(THINKING_CLOSE_STREAM_TAG_RE)];
  const lastOpen = openMatches[openMatches.length - 1];
  const lastClose = closeMatches[closeMatches.length - 1];
  if (!lastOpen) return false;
  if (!lastClose) return true;
  return (lastClose.index ?? -1) < (lastOpen.index ?? -1);
}

export function extractThinkingFromTaggedStream(text: string): string {
  if (!text) return "";
  const closed = extractThinkingFromTaggedText(text);
  if (closed) return closed;
  if (!hasUnclosedThinkingTag(text)) return "";
  const openMatches = [...text.matchAll(THINKING_OPEN_STREAM_TAG_RE)];
  const lastOpen = openMatches[openMatches.length - 1];
  if (!lastOpen) return "";
  const start = (lastOpen.index ?? 0) + lastOpen[0].length;
  return text.slice(start).trim();
}
