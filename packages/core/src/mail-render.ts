import { convert } from 'html-to-text';

const UPLOAD_URL_RE = /\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?inline=1)?/gi;
const UPLOAD_SRC_EXACT_RE = /^\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?inline=1)?$/i;
const CID_IMG_RE = /^cid:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@mailisle)$/i;

const STRIP_WITH_CONTENT_TAGS = [
  'script', 'style', 'head', 'title', 'noscript', 'template',
  'iframe', 'object', 'embed', 'svg', 'math', 'form', 'button', 'select', 'textarea', 'video', 'audio',
];
const STRIP_BLOCK_RE = new RegExp(
  `<(${STRIP_WITH_CONTENT_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi',
);
const STRIP_VOID_RE = /<\/?(?:script|style|head|title|meta|link|base|iframe|object|embed|svg|math|form|input|button|select|textarea|video|audio|source|noscript|template)\b[^>]*>/gi;

const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'blockquote', 'pre', 'code', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'sub', 'sup', 'mark',
  'ul', 'ol', 'li', 'a',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
  'img',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);

const SAFE_COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]{3,20})$/i;
const SAFE_ALIGN_RE = /^(?:left|right|center|justify|start|end)$/i;
const SAFE_FONT_WEIGHT_RE = /^(?:normal|bold|bolder|lighter|[1-9]00)$/i;
const SAFE_FONT_STYLE_RE = /^(?:normal|italic|oblique)$/i;
const SAFE_DECORATION_RE = /^(?:none|underline|line-through(?:\s+underline)?|underline\s+line-through)$/i;

const DEFAULT_INLINE_STYLES: Record<string, string> = {
  p: 'margin:0 0 10px 0;',
  blockquote: 'margin:12px 0;padding:2px 0 2px 14px;border-left:3px solid #cbd6ce;color:#55655c;',
  pre: 'margin:12px 0;padding:12px 14px;border-radius:6px;background-color:#f4f7f4;border:1px solid #e3e9e3;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-x:auto;',
  code: 'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:0.92em;background-color:#f2f5f2;padding:1px 5px;border-radius:4px;',
  h1: 'margin:16px 0 8px 0;font-size:21px;line-height:1.35;font-weight:600;',
  h2: 'margin:14px 0 8px 0;font-size:18px;line-height:1.4;font-weight:600;',
  h3: 'margin:12px 0 6px 0;font-size:16px;line-height:1.45;font-weight:600;',
  ul: 'margin:8px 0 12px 0;padding-left:24px;',
  ol: 'margin:8px 0 12px 0;padding-left:24px;',
  li: 'margin:3px 0;',
  a: 'color:#176c54;text-decoration:underline;',
  hr: 'border:0;border-top:1px solid #d3dcd5;margin:16px 0;',
  table: 'border-collapse:collapse;margin:12px 0;max-width:100%;width:auto;',
  th: 'border:1px solid #d3dcd5;background-color:#f4f7f4;padding:7px 11px;text-align:left;font-weight:600;',
  td: 'border:1px solid #d3dcd5;padding:7px 11px;vertical-align:top;',
  img: 'max-width:100%;height:auto;border-radius:4px;',
  mark: 'background-color:#fff2a8;color:inherit;padding:0 2px;border-radius:2px;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs.set(name, decodeAttr(value));
  }
  return attrs;
}

function sanitizeInlineStyle(raw: string): string {
  if (!raw) return '';
  const kept: string[] = [];
  for (const decl of raw.split(';')) {
    const colon = decl.indexOf(':');
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (!val || /[{}<>\\]/.test(val) || /url\s*\(|expression\s*\(|@import|var\s*\(/i.test(val)) continue;
    if ((prop === 'color' || prop === 'background-color') && SAFE_COLOR_RE.test(val)) kept.push(`${prop}:${val}`);
    else if (prop === 'text-align' && SAFE_ALIGN_RE.test(val)) kept.push(`${prop}:${val}`);
    else if (prop === 'font-weight' && SAFE_FONT_WEIGHT_RE.test(val)) kept.push(`${prop}:${val}`);
    else if (prop === 'font-style' && SAFE_FONT_STYLE_RE.test(val)) kept.push(`${prop}:${val}`);
    else if (prop === 'text-decoration' && SAFE_DECORATION_RE.test(val)) kept.push(`${prop}:${val}`);
  }
  return kept.length ? `${kept.join(';')};` : '';
}

function sanitizeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return parsed.toString();
  } catch { /* Reject relative or malformed links in email bodies. */ }
  return null;
}

type SanitizeOptions = {
  cidToUrl?: Map<string, string>;
  allowCidMailisle?: boolean;
  injectDefaultStyles?: boolean;
};

function sanitizeHtmlInternal(html: string, options: SanitizeOptions): string {
  if (!html) return '';
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(STRIP_BLOCK_RE, '')
    .replace(STRIP_VOID_RE, '');

  // Track whether we are inside <pre> so nested <code> gets clean formatting without double backgrounds.
  let preDepth = 0;

  cleaned = cleaned.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?(\/?)>/g, (_whole, closing: string, rawTag: string, rawAttrs: string | undefined) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (closing) {
      if (VOID_TAGS.has(tag)) return '';
      if (tag === 'pre' && preDepth > 0) preDepth--;
      return `</${tag}>`;
    }

    const attrs = rawAttrs ? parseAttributes(rawAttrs) : new Map<string, string>();
    const outAttrs: string[] = [];

    if (tag === 'img') {
      const src = attrs.get('src') ?? '';
      let safeSrc: string | null = null;
      if (UPLOAD_SRC_EXACT_RE.test(src)) {
        safeSrc = src;
      } else if (options.allowCidMailisle && CID_IMG_RE.test(src)) {
        safeSrc = src;
      } else if (options.cidToUrl && /^cid:/i.test(src)) {
        let cid = src.slice(4);
        try { cid = decodeURIComponent(cid); } catch { /* Keep literal CID if malformed. */ }
        const key = cid.replace(/^<|>$/g, '').trim().toLowerCase();
        safeSrc = options.cidToUrl.get(key) ?? null;
      }
      // External images, trackers, and raw data URLs are never carried into drafted or outgoing HTML.
      if (!safeSrc) return '';
      outAttrs.push(`src="${escapeHtml(safeSrc)}"`);
      const alt = attrs.get('alt');
      if (alt) outAttrs.push(`alt="${escapeHtml(alt.slice(0, 300))}"`);
    } else if (tag === 'a') {
      const href = sanitizeHref(attrs.get('href') ?? '');
      if (href) {
        outAttrs.push(`href="${escapeHtml(href)}"`);
        outAttrs.push('rel="noopener noreferrer"');
        if (options.injectDefaultStyles) outAttrs.push('target="_blank"');
      }
    } else if (tag === 'th' || tag === 'td') {
      for (const spanAttr of ['colspan', 'rowspan'] as const) {
        const num = Number.parseInt(attrs.get(spanAttr) ?? '', 10);
        if (Number.isFinite(num) && num > 1 && num <= 50) outAttrs.push(`${spanAttr}="${num}"`);
      }
    } else if (tag === 'ol') {
      const start = Number.parseInt(attrs.get('start') ?? '', 10);
      if (Number.isFinite(start) && start > 1 && start <= 10_000) outAttrs.push(`start="${start}"`);
    }

    const userStyle = sanitizeInlineStyle(attrs.get('style') ?? '');
    let baseStyle = options.injectDefaultStyles ? (DEFAULT_INLINE_STYLES[tag] ?? '') : '';
    if (options.injectDefaultStyles && tag === 'code' && preDepth > 0) {
      baseStyle = 'font-family:inherit;background:none;padding:0;';
    }
    const mergedStyle = `${baseStyle}${userStyle}`;
    if (mergedStyle) outAttrs.push(`style="${escapeHtml(mergedStyle)}"`);

    if (tag === 'pre') preDepth++;
    return outAttrs.length ? `<${tag} ${outAttrs.join(' ')}>` : `<${tag}>`;
  });

  return cleaned.trim();
}

/**
 * Extracts deduplicated upload UUIDs referenced as inline images (`/api/uploads/<uuid>`) inside HTML.
 */
export function extractInlineUploadIds(html: string): string[] {
  if (!html) return [];
  const ids = new Set<string>();
  const re = new RegExp(UPLOAD_URL_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) ids.add(match[1].toLowerCase());
  return [...ids];
}

/**
 * Rewrites internal `/api/uploads/<uuid>` image sources to RFC 2392 `cid:<uuid>@mailisle` for SMTP MIME delivery.
 */
export function rewriteInlineImagesToCid(html: string, validInlineIds: Set<string>): string {
  if (!html || !validInlineIds.size) return html;
  return html.replace(
    /(\bsrc\s*=\s*["'])\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?inline=1)?(["'])/gi,
    (whole, prefix: string, id: string, suffix: string) => {
      const normalized = id.toLowerCase();
      return validInlineIds.has(normalized) ? `${prefix}cid:${normalized}@mailisle${suffix}` : whole;
    },
  );
}

/**
 * Sanitizes original email HTML for quoting in replies and forwards.
 * Preserves tables, lists, links, headings, and mapped inline CID images while removing scripts, styles, and remote trackers.
 */
export function sanitizeQuoteHtml(html: string, cidToUrl?: Map<string, string>): string {
  return sanitizeHtmlInternal(html, { cidToUrl, allowCidMailisle: false, injectDefaultStyles: false });
}

/** Returns true if sanitized HTML contains visible text or at least one retained inline image. */
export function hasMeaningfulHtml(html: string): boolean {
  if (!html) return false;
  if (/<img\b/i.test(html)) return true;
  const text = html.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;|\s+/gi, '');
  return text.length > 0;
}

/**
 * Renders composer HTML into a self-contained, email-client-safe HTML document with inline styles
 * so blockquotes, code blocks, tables, lists, and blank lines render consistently in Gmail/Outlook/Apple Mail.
 */
export function renderOutgoingHtml(html: string): string {
  const sanitized = sanitizeHtmlInternal(html, { allowCidMailisle: true, injectDefaultStyles: true });
  // Empty paragraphs collapse to zero height in many webmail clients unless they contain a <br>.
  const withBlankLines = sanitized.replace(/<p(\s[^>]*)?>\s*<\/p>/gi, '<p$1><br></p>');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.65;color:#1f2f28;">${withBlankLines}</body></html>`;
}

/**
 * Generates clean, structured `text/plain` for `multipart/alternative` from HTML, preserving list markers,
 * blockquote `> ` prefixes, link URLs, horizontal rules, and table spacing.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  return convert(html, {
    wordwrap: false,
    preserveNewlines: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'hr', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
      { selector: 'blockquote', format: 'blockquote', options: { leadingLineBreaks: 2, trailingLineBreaks: 2, trimEmptyLines: true } },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
      { selector: 'table', format: 'dataTable' },
    ],
  }).replace(/\n{3,}/g, '\n\n').trim();
}
