import DOMPurify from 'dompurify';

const inlineImage = /^data:image\/(png|jpeg|gif|webp);base64,/i;

// Mail keeps the sender's CSS, so two things stand between that CSS and the network. The frame's own
// policy below lets nothing load except inline data: images and inline styles, whatever the CSS says.
// Before that, scrubDeclarations() removes every declaration that names an outside resource, so the
// policy is a backstop and not the only guard. The frame's sandbox runs no script either way.
const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const baseStyle = [
  'html{color-scheme:light}',
  'body{margin:0;padding:20px 28px;font:15px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2f28;background:#fff;overflow-wrap:anywhere}',
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
}

function scrubRules(container: { cssRules: CSSRuleList; deleteRule(index: number): void }) {
  for (let i = container.cssRules.length - 1; i >= 0; i--) {
    const rule = container.cssRules[i];
    if (rule instanceof CSSImportRule || rule instanceof CSSFontFaceRule) { container.deleteRule(i); continue; }
    if ('style' in rule) scrubDeclarations(rule.style as CSSStyleDeclaration);
    if ('cssRules' in rule) scrubRules(rule as CSSGroupingRule);
  }
}

function scrubSheet(css: string): string {
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(css); } catch { return ''; }
  scrubRules(sheet);
  return [...sheet.cssRules].map(rule => rule.cssText).join('\n');
}

/** Builds the document shown in the sandboxed reader frame and reports how many images were held back. */
export function mailDocument(html: string): { document: string; blockedImages: number } {
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
  for (const image of body.querySelectorAll('img')) {
    if (inlineImage.test(image.getAttribute('src') ?? '')) continue;
    const size = Math.min(Number(image.getAttribute('width') ?? 99), Number(image.getAttribute('height') ?? 99));
    if (size <= 2) { image.remove(); continue; } // tracking pixel
    blockedImages++;
    // A held-back image leaves its description behind as a small label; one without a description is decoration.
    const description = image.getAttribute('alt')?.trim();
    if (!description) { image.remove(); continue; }
    const label = image.ownerDocument.createElement('span');
    label.className = 'mail-blocked-image';
    label.textContent = description;
    image.replaceWith(label);
  }
  for (const link of body.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  return {
    document: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>${baseStyle}</style></head><body>${body.innerHTML}</body></html>`,
    blockedImages,
  };
}
