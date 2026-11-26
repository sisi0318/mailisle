import { describe, expect, it } from 'vitest';
import {
  extractInlineUploadIds,
  htmlToPlainText,
  renderOutgoingHtml,
  rewriteInlineImagesToCid,
  sanitizeQuoteHtml,
} from './mail-render';

describe('mail-render', () => {
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';

  it('extracts inline upload UUIDs and rewrites valid ones to cid', () => {
    const html = `<p>看图 <img src="/api/uploads/${idA}?inline=1" alt="截图"><img src="/api/uploads/${idB}"></p>`;
    expect(extractInlineUploadIds(html)).toEqual([idA, idB]);
    const rewritten = rewriteInlineImagesToCid(html, new Set([idA]));
    expect(rewritten).toContain(`src="cid:${idA}@mailisle"`);
    expect(rewritten).toContain(`src="/api/uploads/${idB}"`);
  });

  it('sanitizes quoted HTML while keeping tables, lists, safe styles and mapped CID images', () => {
    const cidMap = new Map([['logo@example', `/api/uploads/${idA}?inline=1`]]);
    const dirty = [
      '<style>body{background:url(https://evil.invalid/track)}</style>',
      '<script>alert(1)</script>',
      '<p style="color:#176c54;background:url(https://evil.invalid);text-align:center">你好 <a href="javascript:alert(1)">坏链</a> <a href="https://example.com/doc">好链</a></p>',
      '<img src="https://tracker.invalid/pixel.gif" width="1" height="1">',
      '<img src="cid:LOGO@example" alt="徽标">',
      '<table><tr><th colspan="2">标题</th></tr><tr><td>单元</td></tr></table>',
    ].join('');
    const clean = sanitizeQuoteHtml(dirty, cidMap);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('<style');
    expect(clean).not.toContain('tracker.invalid');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('evil.invalid');
    expect(clean).toContain('href="https://example.com/doc"');
    expect(clean).toContain(`src="/api/uploads/${idA}?inline=1"`);
    expect(clean).toContain('alt="徽标"');
    expect(clean).toContain('<table>');
    expect(clean).toContain('colspan="2"');
    expect(clean).toContain('color:#176c54');
    expect(clean).toContain('text-align:center');
  });

  it('renders email-safe HTML with inline styles and preserved empty paragraphs', () => {
    const out = renderOutgoingHtml(`<p>第一段</p><p></p><blockquote><p>引用</p></blockquote><pre><code>const x = 1;</code></pre><img src="cid:${idA}@mailisle" alt="图">`);
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('<p style="margin:0 0 10px 0;"><br></p>');
    expect(out).toContain('border-left:3px solid');
    expect(out).toContain('background-color:#f4f7f4');
    expect(out).toContain(`src="cid:${idA}@mailisle"`);
  });

  it('converts rich HTML to structured plain text with blockquote markers and links', () => {
    const plain = htmlToPlainText('<p>您好</p><ul><li>第一项</li><li>第二项</li></ul><p>访问 <a href="https://example.com">官网</a></p><blockquote><p>上文内容</p></blockquote>');
    expect(plain).toContain('您好');
    expect(plain).toContain('第一项');
    expect(plain).toContain('https://example.com');
    expect(plain).toContain('> 上文内容');
  });
});
