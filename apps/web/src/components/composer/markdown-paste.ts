import DOMPurify from 'dompurify';

const INTERNAL_UPLOAD_SRC = /^\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?inline=1)?$/i;
const UPLOAD_ID_RE = /\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?inline=1)?/gi;
const SAFE_COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]{3,20})$/i;
const SAFE_ALIGN_RE = /^(?:left|right|center|justify|start|end)$/i;
const SAFE_FONT_WEIGHT_RE = /^(?:normal|bold|bolder|lighter|[1-9]00)$/i;
const SAFE_FONT_STYLE_RE = /^(?:normal|italic|oblique)$/i;
const SAFE_DECORATION_RE = /^(?:none|underline|line-through(?:\s+underline)?|underline\s+line-through)$/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/**
 * Sanitizes draft or clipboard HTML for the TipTap editor.
 * Keeps safe formatting (headings, lists, tables, colors, text alignment, internal uploaded inline images)
 * while stripping scripts, external images/trackers, classes, IDs, and unsafe styles or links.
 */
export function cleanEditorHtml(html: string): string {
  if (!html) return '';
  const body = DOMPurify.sanitize(html, {
    RETURN_DOM: true,
    FORBID_TAGS: ['style', 'script', 'iframe', 'video', 'audio', 'object', 'embed', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea'],
    FORBID_ATTR: ['class', 'id', 'target', 'srcset', 'background', 'ping'],
  }) as HTMLElement;

  for (const img of [...body.querySelectorAll('img')]) {
    const src = img.getAttribute('src')?.trim() ?? '';
    if (!INTERNAL_UPLOAD_SRC.test(src)) {
      img.remove();
      continue;
    }
    img.removeAttribute('style');
    img.removeAttribute('width');
    img.removeAttribute('height');
  }

  for (const link of body.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = link.getAttribute('href')?.trim() ?? '';
    let safe = false;
    try {
      const parsed = new URL(href);
      safe = ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
    } catch { safe = false; }
    if (!safe) {
      link.removeAttribute('href');
    } else {
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }

  for (const el of body.querySelectorAll<HTMLElement>('[style]')) {
    const raw = el.getAttribute('style') ?? '';
    if (/url\s*\(|expression\s*\(|@import|\\|var\s*\(/i.test(raw)) {
      el.removeAttribute('style');
      continue;
    }
    const kept: string[] = [];
    for (const decl of raw.split(';')) {
      const colon = decl.indexOf(':');
      if (colon <= 0) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const val = decl.slice(colon + 1).trim();
      if (!val || /[{}<>]/.test(val)) continue;
      if ((prop === 'color' || prop === 'background-color') && SAFE_COLOR_RE.test(val)) kept.push(`${prop}: ${val}`);
      else if (prop === 'text-align' && SAFE_ALIGN_RE.test(val)) kept.push(`${prop}: ${val}`);
      else if (prop === 'font-weight' && SAFE_FONT_WEIGHT_RE.test(val)) kept.push(`${prop}: ${val}`);
      else if (prop === 'font-style' && SAFE_FONT_STYLE_RE.test(val)) kept.push(`${prop}: ${val}`);
      else if (prop === 'text-decoration' && SAFE_DECORATION_RE.test(val)) kept.push(`${prop}: ${val}`);
    }
    if (kept.length) el.setAttribute('style', kept.join('; '));
    else el.removeAttribute('style');
  }

  return body.innerHTML;
}

export function extractEditorInlineUploadIds(html: string): string[] {
  if (!html) return [];
  const ids = new Set<string>();
  const re = new RegExp(UPLOAD_ID_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) ids.add(match[1].toLowerCase());
  return [...ids];
}

export function plainTextToHtml(text: string): string {
  if (!text.trim()) return '';
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .filter(block => block.trim())
    .map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function looksLikeMarkdown(text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n');
  if (/^```[\w-]*\n[\s\S]+?\n```$/m.test(normalized)) return true;
  if (/^#{1,3}\s+\S/m.test(normalized)) return true;
  if (/^\|.+\|\n\|[\s:|-]+\|$/m.test(normalized)) return true;
  if (/^(?:[-*+]\s+\S.+\n?){2,}/m.test(normalized)) return true;
  if (/^(?:\d+\.\s+\S.+\n?){2,}/m.test(normalized)) return true;
  if (/^>\s+\S/m.test(normalized)) return true;
  if (/\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/.test(normalized)) return true;
  if (/\*\*[^*\n]+\*\*/.test(normalized) || /~~[^~\n]+~~/.test(normalized)) return true;
  return false;
}

function renderInlineMarkdown(line: string): string {
  const codeSlots: string[] = [];
  let text = line.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codeSlots.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `\u0000CODE${idx}\u0000`;
  });
  text = escapeHtml(text);
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, label: string, url: string) =>
    `<a href="${url}" rel="noopener noreferrer">${label}</a>`,
  );
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeSlots[Number(idx)] ?? '');
  return text;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

/** Converts common Markdown blocks (headings, lists, quotes, code fences, tables, inline formatting) to safe HTML. */
export function markdownToHtml(input: string): string {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Fenced code block
    if (/^```/.test(line.trim())) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(line.trim())) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Heading
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Markdown table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const headHtml = `<tr>${headers.map(h => `<th>${renderInlineMarkdown(h)}</th>`).join('')}</tr>`;
      const bodyHtml = rows.map(row => `<tr>${headers.map((_, col) => `<td>${renderInlineMarkdown(row[col] ?? '')}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${markdownToHtml(quoteLines.join('\n')) || '<p></p>'}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li><p>${renderInlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/, ''))}</p></li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li><p>${renderInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ''))}</p></li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Regular paragraph
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(?:```|#{1,3}\s|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|(?:---+|\*\*\*+|___+)\s*$)/.test(lines[i])
    ) {
      para.push(renderInlineMarkdown(lines[i]));
      i++;
    }
    out.push(`<p>${para.join('<br>')}</p>`);
  }

  return out.join('');
}

export type RecipientEntry = { raw: string; name: string; address: string; valid: boolean };

/** Splits an RFC 5322-like recipient string without breaking quoted display names containing commas. */
export function splitRecipientTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let angleDepth = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === '<') angleDepth++;
      else if (ch === '>' && angleDepth > 0) angleDepth--;
      if (angleDepth === 0 && (ch === ',' || ch === ';' || ch === '，' || ch === '；' || ch === '\n' || ch === '\r')) {
        if (current.trim()) tokens.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

export function parseRecipientToken(token: string): RecipientEntry {
  const trimmed = token.trim();
  const angleMatch = /^(.*)<([^<>]+)>\s*$/.exec(trimmed);
  if (angleMatch) {
    const rawName = angleMatch[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').trim();
    const address = angleMatch[2].trim();
    return { raw: rawName ? `${rawName} <${address}>` : address, name: rawName, address, valid: EMAIL_RE.test(address) };
  }
  return { raw: trimmed, name: '', address: trimmed, valid: EMAIL_RE.test(trimmed) };
}

export function parseRecipients(value: string): RecipientEntry[] {
  return splitRecipientTokens(value).map(parseRecipientToken);
}

export function formatRecipients(entries: RecipientEntry[]): string {
  return entries.map(entry => {
    if (!entry.name) return entry.address;
    const safeName = /[,;"]/.test(entry.name) ? `"${entry.name.replace(/"/g, '\\"')}"` : entry.name;
    return `${safeName} <${entry.address}>`;
  }).join(', ');
}
