import DOMPurify from 'dompurify';
import type { InlineImage } from '@mail/shared';

const inlineImage = /^data:image\/(png|jpeg|gif|webp);base64,/i;

// MailIsle keeps the sender's CSS, so two things stand between that CSS and the network. The frame's own
// policy below lets nothing load except inline data: images and inline styles, whatever the CSS says.
// Before that, scrubDeclarations() removes every declaration that names an outside resource, so the
// policy is a backstop and not the only guard. The frame's sandbox runs no script either way.
// Images from the web are added to the policy only for a message whose reader asked to see them; the
// page around the frame allows them in general, because a frame built from a string inherits its policy.
const policy = (remoteImages: boolean) => `default-src 'none'; img-src data:${remoteImages ? ' https: http:' : ''}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;

const baseStyle = [
  'html{color-scheme:light}',
  'body{margin:0;padding:20px 28px;font:15px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2f28;background:#fff;overflow-wrap:anywhere}',
  '@media(max-width:600px){body{padding:16px}}',
  'img{max-width:100%;height:auto}',
  'table{max-width:100%}',
  'a{color:#176c54}',
  'pre{white-space:pre-wrap}',
  'blockquote{margin:12px 0;padding-left:12px;border-left:3px solid #d3dcd5;color:#55655c}',
  '.mail-blocked-image{display:inline-block;padding:1px 8px;border:1px dashed #c9d3cb;border-radius:4px;background:#f3f6f3;color:#55655c;font:12px/1.6 system-ui,sans-serif}',
].join('');

const fetchesResource = /url\(|image-set\(|image\(|src\(/i;

/**
 * Removes declarations that would fetch something. Values are read back from the browser's parser,
 * which has already resolved escapes such as `u\72l(`, so matching on the text is reliable. Custom
 * properties are stored unparsed, so one holding a function or an escape is removed outright.
 */
function scrubDeclarations(style: CSSStyleDeclaration) {
  for (let i = style.length - 1; i >= 0; i--) {
    const property = style[i];
    const value = style.getPropertyValue(property);
    if (property.startsWith('--') ? /[(\\]/.test(value) : fetchesResource.test(value)) style.removeProperty(property);
  }
  // A shorthand that contains var() is kept unparsed and its longhands read back empty, so a url() next to
  // the var() is invisible above. The whole block goes rather than letting it through.
  if (fetchesResource.test(style.cssText)) style.cssText = '';
}

function scrubRules(container: { cssRules: CSSRuleList; deleteRule(index: number): void }) {
  for (let i = container.cssRules.length - 1; i >= 0; i--) {
    const rule = container.cssRules[i];
    if (rule instanceof CSSImportRule || rule instanceof CSSFontFaceRule) { container.deleteRule(i); continue; }
    if ('style' in rule) scrubDeclarations(rule.style as CSSStyleDeclaration);
    if ('cssRules' in rule) scrubRules(rule as CSSGroupingRule);
    // Rule types this function does not know by name, present or future, are dropped if they still name a resource.
    if (fetchesResource.test(rule.cssText)) container.deleteRule(i);
  }
}

function scrubSheet(css: string): string {
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(css); } catch { return ''; }
  scrubRules(sheet);
  // The browser writes strings back with their escapes resolved, so `"\3c /style\3e "` returns as a literal
  // `</style>` that would close the element early and let the rest of the sheet in as markup. `<\/` is the
  // same character sequence to a CSS parser and nothing to an HTML parser.
  return [...sheet.cssRules].map(rule => rule.cssText).join('\n').replace(/<\//g, '<\\/');
}

/**
 * Builds the document shown in the sandboxed reader frame. `blockedImages` is how many images were held
 * back, `remoteImages` how many of the message's images are on the web and could be, or are being, shown.
 */
export function mailDocument(html: string, inlineImages: InlineImage[] = [], options: { remoteImages?: boolean } = {}): { document: string; blockedImages: number; remoteImages: number; embeddedAttachmentIds: string[] } {
  const cidImages = new Map(inlineImages.map(image => [image.contentId, image]));
  const embedded = new Set<string>();
  const body = DOMPurify.sanitize(html, {
    RETURN_DOM: true,
    FORCE_BODY: true, // keeps a leading <style> block, which mail usually has
    FORBID_TAGS: ['link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea', 'video', 'audio', 'source', 'svg', 'math'],
    FORBID_ATTR: ['srcset', 'background', 'ping'],
  }) as HTMLElement;
  for (const sheet of body.querySelectorAll('style')) sheet.textContent = scrubSheet(sheet.textContent ?? '');
  for (const element of body.querySelectorAll<HTMLElement>('[style]')) {
    scrubDeclarations(element.style);
    if (!element.style.length) element.removeAttribute('style');
  }
  let blockedImages = 0;
  let remoteImages = 0;
  for (const image of body.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    if (/^cid:/i.test(source)) {
      let contentId = source.slice(4);
      try { contentId = decodeURIComponent(contentId); } catch { /* Invalid URI escapes remain literal IDs. */ }
      const inline = cidImages.get(contentId.replace(/^<|>$/g, '').trim());
      if (inline && inlineImage.test(inline.dataUrl)) {
        image.setAttribute('src', inline.dataUrl);
        embedded.add(inline.attachmentId);
      }
    }
    if (inlineImage.test(image.getAttribute('src') ?? '')) continue;
    // A missing or empty size is unknown, not zero.
    const dimension = (name: string) => { const value = parseInt(image.getAttribute(name) ?? '', 10); return Number.isNaN(value) ? 99 : value; };
    const size = Math.min(dimension('width'), dimension('height'));
    if (size <= 2) { image.remove(); continue; } // tracking pixel, also when images are shown
    // Only ordinary web addresses can be shown on request; anything else stays held back.
    const remote = /^https?:\/\//i.test(source) ? source : source.startsWith('//') ? `https:${source}` : null;
    if (remote) remoteImages++;
    if (remote && options.remoteImages) {
      image.setAttribute('src', remote);
      image.setAttribute('referrerpolicy', 'no-referrer');
      continue;
    }
    blockedImages++;
    // A held-back image leaves its description behind as a small label; one without a description is decoration.
    const description = image.getAttribute('alt')?.trim();
    if (!description) { image.remove(); continue; }
    const label = image.ownerDocument.createElement('span');
    label.className = 'mail-blocked-image';
    label.textContent = description;
    image.replaceWith(label);
  }
  // Image maps link out as well. Without a target they would load the destination inside the reader frame.
  for (const link of body.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>('a, area')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; link.removeAttribute('download'); }
  return {
    // Browsers may resolve the host names of links ahead of a click; for mail that would tell the sender it was opened.
    document: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy(!!options.remoteImages)}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><style>${baseStyle}</style></head><body>${body.innerHTML}</body></html>`,
    blockedImages,
    remoteImages,
    embeddedAttachmentIds: [...embedded],
  };
}
