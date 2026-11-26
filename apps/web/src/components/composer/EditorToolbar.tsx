import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  AlignCenter, AlignLeft, AlignRight, Bold, ChevronDown, Code, Code2, Eraser,
  Heading, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, Minus,
  Palette, Paperclip, Quote, Redo2, Strikethrough, Table2, Type, Underline, Undo2, Unlink,
} from 'lucide-react';
import { Button, Toolbar } from '../ui';

const TEXT_COLORS = [
  { label: '默认', value: '' },
  { label: '墨绿', value: '#176c54' },
  { label: '深蓝', value: '#1d4ed8' },
  { label: '绛红', value: '#b91c1c' },
  { label: '琥珀', value: '#b45309' },
  { label: '紫灰', value: '#6d28d9' },
  { label: '次要灰', value: '#55655c' },
];

const HIGHLIGHT_COLORS = [
  { label: '无底色', value: '' },
  { label: '暖黄', value: '#fef08a' },
  { label: '浅绿', value: '#dcfce7' },
  { label: '浅蓝', value: '#dbeafe' },
  { label: '浅粉', value: '#fee2e2' },
  { label: '浅紫', value: '#ede9fe' },
];

type Props = {
  editor: Editor | null;
  plainMode: boolean;
  disabled: boolean;
  uploading: boolean;
  onTogglePlainMode: () => void;
  onPickAttachment: () => void;
  onPickInlineImage: () => void;
};

function hidePopover(el: HTMLElement | null) {
  if (!el) return;
  try { if (el.matches(':popover-open')) el.hidePopover(); } catch { /* noop */ }
}

export function EditorToolbar({ editor, plainMode, disabled, uploading, onTogglePlainMode, onPickAttachment, onPickInlineImage }: Props) {
  const headingId = useId();
  const colorId = useId();
  const alignId = useId();
  const linkId = useId();
  const tableId = useId();

  const headingPop = useRef<HTMLDivElement>(null);
  const colorPop = useRef<HTMLDivElement>(null);
  const alignPop = useRef<HTMLDivElement>(null);
  const linkPop = useRef<HTMLDivElement>(null);
  const tablePop = useRef<HTMLDivElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);

  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const [linkError, setLinkError] = useState('');

  const state = useEditorState({
    editor,
    selector: ctx => {
      const ed = ctx.editor;
      if (!ed) return null;
      return {
        canUndo: ed.can().undo(),
        canRedo: ed.can().redo(),
        h1: ed.isActive('heading', { level: 1 }),
        h2: ed.isActive('heading', { level: 2 }),
        h3: ed.isActive('heading', { level: 3 }),
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        underline: ed.isActive('underline'),
        strike: ed.isActive('strike'),
        code: ed.isActive('code'),
        codeBlock: ed.isActive('codeBlock'),
        bulletList: ed.isActive('bulletList'),
        orderedList: ed.isActive('orderedList'),
        blockquote: ed.isActive('blockquote'),
        link: ed.isActive('link'),
        inTable: ed.isActive('table'),
        alignCenter: ed.isActive({ textAlign: 'center' }),
        alignRight: ed.isActive({ textAlign: 'right' }),
        textColor: (ed.getAttributes('textStyle').color as string | undefined) ?? '',
        highlightColor: (ed.getAttributes('highlight').color as string | undefined) ?? '',
      };
    },
  });

  useEffect(() => {
    const el = linkPop.current;
    if (!el) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open' || !editor) return;
      const attrs = editor.getAttributes('link');
      const { from, to } = editor.state.selection;
      setLinkUrl((attrs.href as string | undefined) ?? '');
      setLinkText(from < to ? editor.state.doc.textBetween(from, to, ' ') : '');
      setLinkError('');
      requestAnimationFrame(() => linkInput.current?.focus());
    };
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, [editor]);

  function applyLink() {
    if (!editor) return;
    const trimmed = linkUrl.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      hidePopover(linkPop.current);
      return;
    }
    const candidate = /^https?:\/\/|^mailto:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('bad');
      const href = parsed.toString();
      const { from, to } = editor.state.selection;
      if (from === to && !editor.isActive('link')) {
        const label = linkText.trim() || href;
        editor.chain().focus().insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }).run();
      } else {
        editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
      }
      setLinkError('');
      hidePopover(linkPop.current);
    } catch {
      setLinkError('请输入有效的 http(s):// 或 mailto: 链接');
    }
  }

  const fmtDisabled = disabled || plainMode || !editor;
  const headingLabel = state?.h1 ? '标题 1' : state?.h2 ? '标题 2' : state?.h3 ? '标题 3' : '正文';

  const btn = (label: string, pressed: boolean | undefined, run: () => void, icon: ReactNode, extraDisabled = false) => (
    <Button
      type="button"
      variant="ghost"
      disabled={fmtDisabled || extraDisabled}
      aria-label={label}
      title={label}
      aria-pressed={pressed !== undefined ? !!pressed : undefined}
      className={pressed ? 'active' : ''}
      onMouseDown={event => event.preventDefault()}
      onClick={run}
    >
      {icon}
    </Button>
  );

  return <Toolbar className="editor-toolbar" aria-label="格式工具栏">
    {!plainMode && <>
      {btn('撤销 (Ctrl+Z)', undefined, () => editor?.chain().focus().undo().run(), <Undo2 size={15} aria-hidden />, !state?.canUndo)}
      {btn('重做 (Ctrl+Y)', undefined, () => editor?.chain().focus().redo().run(), <Redo2 size={15} aria-hidden />, !state?.canRedo)}
      <span className="toolbar-divider" aria-hidden />

      <div className="toolbar-anchor">
        <Button
          type="button"
          variant="ghost"
          className="toolbar-select-trigger"
          disabled={fmtDisabled}
          title="段落样式"
          popoverTarget={headingId}
          onMouseDown={event => event.preventDefault()}
        >
          <Heading size={15} aria-hidden />
          <span>{headingLabel}</span>
          <ChevronDown size={13} aria-hidden />
        </Button>
        <div id={headingId} ref={headingPop} popover="auto" className="toolbar-popover toolbar-panel-list">
          <button type="button" className={!state?.h1 && !state?.h2 && !state?.h3 ? 'active' : undefined} onClick={() => { editor?.chain().focus().setParagraph().run(); hidePopover(headingPop.current); }}>正文</button>
          <button type="button" className={`heading-opt-1${state?.h1 ? ' active' : ''}`} onClick={() => { editor?.chain().focus().toggleHeading({ level: 1 }).run(); hidePopover(headingPop.current); }}>标题 1</button>
          <button type="button" className={`heading-opt-2${state?.h2 ? ' active' : ''}`} onClick={() => { editor?.chain().focus().toggleHeading({ level: 2 }).run(); hidePopover(headingPop.current); }}>标题 2</button>
          <button type="button" className={`heading-opt-3${state?.h3 ? ' active' : ''}`} onClick={() => { editor?.chain().focus().toggleHeading({ level: 3 }).run(); hidePopover(headingPop.current); }}>标题 3</button>
        </div>
      </div>

      {btn('加粗 (Ctrl+B)', state?.bold, () => editor?.chain().focus().toggleBold().run(), <Bold size={15} aria-hidden />)}
      {btn('斜体 (Ctrl+I)', state?.italic, () => editor?.chain().focus().toggleItalic().run(), <Italic size={15} aria-hidden />)}
      {btn('下划线 (Ctrl+U)', state?.underline, () => editor?.chain().focus().toggleUnderline().run(), <Underline size={15} aria-hidden />)}
      {btn('删除线', state?.strike, () => editor?.chain().focus().toggleStrike().run(), <Strikethrough size={15} aria-hidden />)}

      <div className="toolbar-anchor">
        <Button
          type="button"
          variant="ghost"
          disabled={fmtDisabled}
          aria-label="文字颜色与高亮"
          title="文字颜色与高亮"
          className={state?.textColor || state?.highlightColor ? 'active' : ''}
          popoverTarget={colorId}
          onMouseDown={event => event.preventDefault()}
        >
          <Palette size={15} aria-hidden />
        </Button>
        <div id={colorId} ref={colorPop} popover="auto" className="toolbar-popover toolbar-colors">
          <div className="color-group">
            <span>文字颜色</span>
            <div className="color-swatches">
              {TEXT_COLORS.map(item => (
                <button
                  key={item.label}
                  type="button"
                  title={item.label}
                  aria-label={`文字颜色：${item.label}`}
                  className={`color-swatch${(state?.textColor ?? '') === item.value ? ' active' : ''}`}
                  style={item.value ? { backgroundColor: item.value } : undefined}
                  onClick={() => {
                    if (item.value) editor?.chain().focus().setColor(item.value).run();
                    else editor?.chain().focus().unsetColor().run();
                    hidePopover(colorPop.current);
                  }}
                >
                  {!item.value && <Type size={12} aria-hidden />}
                </button>
              ))}
            </div>
          </div>
          <div className="color-group">
            <span>背景高亮</span>
            <div className="color-swatches">
              {HIGHLIGHT_COLORS.map(item => (
                <button
                  key={item.label}
                  type="button"
                  title={item.label}
                  aria-label={`背景高亮：${item.label}`}
                  className={`color-swatch${(state?.highlightColor ?? '') === item.value ? ' active' : ''}`}
                  style={item.value ? { backgroundColor: item.value } : undefined}
                  onClick={() => {
                    if (item.value) editor?.chain().focus().setHighlight({ color: item.value }).run();
                    else editor?.chain().focus().unsetHighlight().run();
                    hidePopover(colorPop.current);
                  }}
                >
                  {!item.value && <Highlighter size={12} aria-hidden />}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <span className="toolbar-divider" aria-hidden />

      {btn('项目列表', state?.bulletList, () => editor?.chain().focus().toggleBulletList().run(), <List size={15} aria-hidden />)}
      {btn('编号列表', state?.orderedList, () => editor?.chain().focus().toggleOrderedList().run(), <ListOrdered size={15} aria-hidden />)}
      {btn('引用块', state?.blockquote, () => editor?.chain().focus().toggleBlockquote().run(), <Quote size={15} aria-hidden />)}
      {btn('行内代码', state?.code, () => editor?.chain().focus().toggleCode().run(), <Code size={15} aria-hidden />)}
      {btn('代码块', state?.codeBlock, () => editor?.chain().focus().toggleCodeBlock().run(), <Code2 size={15} aria-hidden />)}
      {btn('分割线', undefined, () => editor?.chain().focus().setHorizontalRule().run(), <Minus size={15} aria-hidden />)}

      <div className="toolbar-anchor">
        <Button
          type="button"
          variant="ghost"
          disabled={fmtDisabled}
          aria-label="对齐方式"
          title="对齐方式"
          popoverTarget={alignId}
          onMouseDown={event => event.preventDefault()}
        >
          {state?.alignCenter ? <AlignCenter size={15} aria-hidden /> : state?.alignRight ? <AlignRight size={15} aria-hidden /> : <AlignLeft size={15} aria-hidden />}
        </Button>
        <div id={alignId} ref={alignPop} popover="auto" className="toolbar-popover toolbar-panel-list">
          <button type="button" onClick={() => { editor?.chain().focus().setTextAlign('left').run(); hidePopover(alignPop.current); }}><AlignLeft size={14} aria-hidden />左对齐</button>
          <button type="button" onClick={() => { editor?.chain().focus().setTextAlign('center').run(); hidePopover(alignPop.current); }}><AlignCenter size={14} aria-hidden />居中</button>
          <button type="button" onClick={() => { editor?.chain().focus().setTextAlign('right').run(); hidePopover(alignPop.current); }}><AlignRight size={14} aria-hidden />右对齐</button>
        </div>
      </div>

      <span className="toolbar-divider" aria-hidden />

      <div className="toolbar-anchor">
        <Button
          type="button"
          variant="ghost"
          disabled={fmtDisabled}
          aria-label="插入或编辑链接"
          title="插入或编辑链接"
          className={state?.link ? 'active' : ''}
          popoverTarget={linkId}
          onMouseDown={event => event.preventDefault()}
        >
          <Link2 size={15} aria-hidden />
        </Button>
        <div id={linkId} ref={linkPop} popover="auto" className="toolbar-popover toolbar-link-panel">
          <div className="toolbar-link-fields">
            <label>链接地址<input ref={linkInput} type="url" value={linkUrl} placeholder="https://example.com" onChange={event => setLinkUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyLink(); } }} /></label>
            {!state?.link && <label>显示文字（可选）<input type="text" value={linkText} placeholder="默认使用选中文本或网址" onChange={event => setLinkText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyLink(); } }} /></label>}
            {linkError && <p className="error">{linkError}</p>}
            <div className="button-row">
              {state?.link && <Button type="button" variant="ghost" onClick={() => { editor?.chain().focus().extendMarkRange('link').unsetLink().run(); hidePopover(linkPop.current); }}><Unlink size={14} aria-hidden />移除</Button>}
              <Button type="button" variant="primary" onClick={applyLink}>确定</Button>
            </div>
          </div>
        </div>
      </div>

      <div className="toolbar-anchor">
        <Button
          type="button"
          variant="ghost"
          disabled={fmtDisabled}
          aria-label="表格操作"
          title="表格"
          className={state?.inTable ? 'active' : ''}
          popoverTarget={tableId}
          onMouseDown={event => event.preventDefault()}
        >
          <Table2 size={15} aria-hidden />
        </Button>
        <div id={tableId} ref={tablePop} popover="auto" className="toolbar-popover toolbar-panel-list">
          {!state?.inTable ? (
            <button type="button" onClick={() => { editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); hidePopover(tablePop.current); }}>插入 3×3 表格</button>
          ) : <>
            <button type="button" onClick={() => { editor?.chain().focus().addRowBefore().run(); hidePopover(tablePop.current); }}>在上方插入行</button>
            <button type="button" onClick={() => { editor?.chain().focus().addRowAfter().run(); hidePopover(tablePop.current); }}>在下方插入行</button>
            <button type="button" onClick={() => { editor?.chain().focus().deleteRow().run(); hidePopover(tablePop.current); }}>删除当前行</button>
            <button type="button" onClick={() => { editor?.chain().focus().addColumnBefore().run(); hidePopover(tablePop.current); }}>在左侧插入列</button>
            <button type="button" onClick={() => { editor?.chain().focus().addColumnAfter().run(); hidePopover(tablePop.current); }}>在右侧插入列</button>
            <button type="button" onClick={() => { editor?.chain().focus().deleteColumn().run(); hidePopover(tablePop.current); }}>删除当前列</button>
            <button type="button" className="danger-item" onClick={() => { editor?.chain().focus().deleteTable().run(); hidePopover(tablePop.current); }}>删除表格</button>
          </>}
        </div>
      </div>

      {btn('插入图片', undefined, onPickInlineImage, <ImagePlus size={15} aria-hidden />, uploading)}
      {btn('清除格式', undefined, () => editor?.chain().focus().clearNodes().unsetAllMarks().run(), <Eraser size={15} aria-hidden />)}
      <span className="toolbar-divider" aria-hidden />
    </>}

    <Button
      type="button"
      variant="ghost"
      disabled={disabled || uploading}
      title="添加附件"
      onClick={onPickAttachment}
    >
      <Paperclip size={15} aria-hidden />
      <span>附件</span>
    </Button>

    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      className={`toolbar-mode-toggle${plainMode ? ' active' : ''}`}
      aria-pressed={plainMode}
      title={plainMode ? '切换回富文本格式' : '切换为纯文本邮件'}
      onClick={onTogglePlainMode}
    >
      {plainMode ? '纯文本' : '富文本'}
    </Button>
  </Toolbar>;
}
