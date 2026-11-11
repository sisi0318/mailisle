const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const cjkRun = new RegExp(`[${CJK}]+`, 'gu');
const startsWithCjk = new RegExp(`^[${CJK}]`, 'u');
// The pieces of a query term as the index knows them: runs of CJK characters, and words in any other script.
const termPart = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');
const pairs = (chars: string[]) => chars.slice(0, -1).map((char, i) => char + chars[i + 1]);

/** Changes whenever tokenize() stores text differently, so that existing rows are written again. */
export const SEARCH_INDEX_VERSION = '2';

/**
 * Text in the form the full-text index stores. A run of CJK characters becomes its overlapping pairs
 * followed by its last character alone: 电子发票 is stored as 电子 子发 发票 票. Every character then
 * starts some token, which is what lets a single character be found by prefix instead of by reading
 * every message.
 */
export function tokenize(text: string): string {
  return text.replace(cjkRun, run => {
    const chars = [...run];
    return ` ${chars.length === 1 ? run : `${pairs(chars).join(' ')} ${chars.at(-1)}`} `;
  });
}

/**
 * The FTS5 expression for what was typed, or null when it holds nothing the index stores, such as
 * punctuation only. Each word is a phrase of its own and all of them have to occur, in any order.
 */
export function searchExpression(query: string): string | null {
  const phrases = query.split(/\s+/).map(termPhrase).filter(phrase => phrase !== null);
  return phrases.length ? phrases.join(' ') : null;
}

function termPhrase(term: string): string | null {
  const parts = term.match(termPart);
  if (!parts) return null;
  const tokens: string[] = [];
  let prefix = false;
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (!startsWithCjk.test(part)) { tokens.push(part); return; }
    const chars = [...part];
    // A single character at the end may be the start of a longer run in the mail, so it matches by prefix.
    // Anywhere else it is followed by something that is not CJK, so it ends its run and was stored alone.
    if (chars.length === 1) { tokens.push(part); prefix = last; return; }
    tokens.push(...pairs(chars));
    // A run with more of the term after it was stored with its last character behind it; the phrase has to say the same.
    if (!last) tokens.push(chars.at(-1)!);
  });
  return `"${tokens.join(' ')}"${prefix ? ' *' : ''}`;
}

export function previewText(text: string): string {
  return text.replace(/\[(?:https?:\/\/|cid:)[^\]\r\n]*(?:\]|$)/gi, ' ')
    .replace(/https?:\/\/[^\s<>]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
