const cjkRun = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export function tokenize(text: string): string {
  return text.replace(cjkRun, run => {
    const chars = [...run];
    return ` ${chars.length === 1 ? run : chars.slice(0, -1).map((char, i) => char + chars[i + 1]).join(' ')} `;
  });
}

export function searchExpression(query: string): string | null {
  if ([...query.matchAll(cjkRun)].some(([run]) => [...run].length === 1)) return null;
  const tokens = tokenize(query).match(/[\p{L}\p{N}]+/gu);
  return tokens?.length ? `"${tokens.join(' ')}"` : null;
}

export function previewText(text: string): string {
  return text.replace(/\[(?:https?:\/\/|cid:)[^\]\r\n]*(?:\]|$)/gi, ' ')
    .replace(/https?:\/\/[^\s<>]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
