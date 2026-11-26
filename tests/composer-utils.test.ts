import { describe, expect, it } from 'vitest';
import {
  extractEditorInlineUploadIds,
  formatRecipients,
  looksLikeMarkdown,
  markdownToHtml,
  parseRecipients,
  splitRecipientTokens,
} from '../apps/web/src/components/composer/markdown-paste';

describe('composer utilities', () => {
  it('splits recipient tokens without breaking quoted display names containing commas', () => {
    const tokens = splitRecipientTokens('"Doe, John" <john@example.com>, alice@example.com; 王小明 <ming@example.com>');
    expect(tokens).toEqual(['"Doe, John" <john@example.com>', 'alice@example.com', '王小明 <ming@example.com>']);
    const parsed = parseRecipients('"Doe, John" <john@example.com>, bad-email');
    expect(parsed).toEqual([
      { raw: 'Doe, John <john@example.com>', name: 'Doe, John', address: 'john@example.com', valid: true },
      { raw: 'bad-email', name: '', address: 'bad-email', valid: false },
    ]);
    expect(formatRecipients([parsed[0]])).toBe('"Doe, John" <john@example.com>');
  });

  it('detects Markdown structure and converts headings, lists, code, links and tables to HTML', () => {
    expect(looksLikeMarkdown('普通的一段文字，没有 Markdown 语法。')).toBe(false);
    const md = [
      '## 周报',
      '',
      '- **完成** 撰写器重构',
      '- 查看 [文档](https://example.com/docs)',
      '',
      '| 模块 | 状态 |',
      '| --- | --- |',
      '| 编辑器 | 完成 |',
      '',
      '```ts',
      'const ok = true;',
      '```',
    ].join('\n');
    expect(looksLikeMarkdown(md)).toBe(true);
    const html = markdownToHtml(md);
    expect(html).toContain('<h2>周报</h2>');
    expect(html).toContain('<strong>完成</strong>');
    expect(html).toContain('<a href="https://example.com/docs" rel="noopener noreferrer">文档</a>');
    expect(html).toContain('<table><thead><tr><th>模块</th><th>状态</th></tr></thead><tbody><tr><td>编辑器</td><td>完成</td></tr></tbody></table>');
    expect(html).toContain('<pre><code>const ok = true;</code></pre>');
  });

  it('extracts internal uploaded image UUIDs', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(extractEditorInlineUploadIds(`<p><img src="/api/uploads/${id}?inline=1"></p>`)).toEqual([id]);
  });
});
