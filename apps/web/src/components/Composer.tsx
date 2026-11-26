import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Maximize2, Minimize2, Minus, Paperclip, Save, Send, Trash2, Upload as UploadIcon, X } from 'lucide-react';
import { draftSchema, INLINE_IMAGE_MIME, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, sendSchema, type Account, type Draft, type DraftInput, type Upload } from '@mail/shared';
import { api, ApiError, json } from '../api';
import { describeIssues, fileSize } from '../format';
import { Button, ConfirmModal, FileName, Modal } from './ui';
import { EditorToolbar } from './composer/EditorToolbar';
import { RecipientInput } from './composer/RecipientInput';
import { cleanEditorHtml, extractEditorInlineUploadIds, looksLikeMarkdown, markdownToHtml, parseRecipients, plainTextToHtml } from './composer/markdown-paste';

const labels = { accountId: '发件人', to: '收件人', cc: '抄送', bcc: '密送', subject: '主题', text: '正文', html: '正文', attachmentIds: '附件' };
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const modKey = isMac ? '⌘' : 'Ctrl';

function initialHtml(draft?: Draft): string {
  if (draft?.html) return cleanEditorHtml(draft.html);
  return plainTextToHtml(draft?.text ?? '');
}

const isEmptyDraft = (content: DraftInput) =>
  ![content.to, content.cc, content.bcc, content.subject, content.text].some(value => value.trim()) &&
  !extractEditorInlineUploadIds(content.html ?? '').length &&
  !content.attachmentIds.length;

type Props = {
  accounts: Account[];
  draft?: Draft;
  accountId?: string;
  /** The draft was just created for a reply or forward and nobody has decided to keep it yet. */
  fresh?: boolean;
  minimized?: boolean;
  onMinimizedChange?: (minimized: boolean) => void;
  onClose: () => void;
  onSent: (notice: string, needsAttention: boolean) => void;
};

export function Composer({ accounts, draft, accountId, fresh = false, minimized = false, onMinimizedChange, onClose, onSent }: Props) {
  const [senderId, setSenderId] = useState(
    draft?.accountId ??
    accounts.find(account => account.id === accountId && account.sendEnabled)?.id ??
    accounts.find(account => account.sendEnabled)?.id ??
    accounts[0]?.id ??
    '',
  );
  const canSend = !!accounts.find(account => account.id === senderId)?.sendEnabled;
  const query = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [to, setTo] = useState(draft?.to ?? '');
  const [cc, setCc] = useState(draft?.cc ?? '');
  const [bcc, setBcc] = useState(draft?.bcc ?? '');
  const [subject, setSubject] = useState(draft?.subject ?? '');
  const [showCopies, setShowCopies] = useState(!!(draft?.cc || draft?.bcc));
  const [plainMode, setPlainMode] = useState(false);
  const [plainText, setPlainText] = useState(draft?.text ?? '');
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Requests read the ID from here: a save queued behind another one must see the ID the first one created.
  const draftId = useRef(draft?.id);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const dragDepth = useRef(0);
  const [changeTick, setChangeTick] = useState(0);
  const [saved, setSaved] = useState(!!draft);
  const [uploads, setUploads] = useState<Upload[]>(draft?.attachments ?? []);
  const [inlineIds, setInlineIds] = useState<string[]>(() => extractEditorInlineUploadIds(draft?.html ?? ''));
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState(draft && !fresh ? '已载入本地草稿' : '');
  const [error, setError] = useState('');
  const [asking, setAsking] = useState<'close' | 'delete' | 'no-subject' | null>(null);
  const pendingSendRef = useRef<DraftInput | null>(null);

  const markChanged = useCallback(() => {
    revision.current++;
    setDirty(true);
    setChangeTick(count => count + 1);
  }, []);

  const refreshLists = useCallback(() => {
    void query.invalidateQueries({ queryKey: ['drafts'] });
    void query.invalidateQueries({ queryKey: ['counts'] });
  }, [query]);

  const inlineIdSet = useMemo(() => new Set(inlineIds.map(id => id.toLowerCase())), [inlineIds]);
  const visibleAttachments = useMemo(
    () => uploads.filter(file => !inlineIdSet.has(file.id.toLowerCase())),
    [uploads, inlineIdSet],
  );
  const totalUploadBytes = useMemo(() => {
    const activeIds = new Set([...visibleAttachments.map(f => f.id.toLowerCase()), ...inlineIdSet]);
    return uploads.filter(file => activeIds.has(file.id.toLowerCase())).reduce((sum, file) => sum + file.size, 0);
  }, [uploads, visibleAttachments, inlineIdSet]);

  const uploadFiles = useMutation({
    mutationFn: async ({ files, insertInline }: { files: File[]; insertInline: boolean }) => {
      const currentActive = new Set([...visibleAttachments.map(f => f.id.toLowerCase()), ...inlineIdSet]);
      const currentUploads = uploads.filter(file => currentActive.has(file.id.toLowerCase()));
      if (currentUploads.length + files.length > MAX_ATTACHMENTS) throw new Error(`最多添加 ${MAX_ATTACHMENTS} 个附件或内嵌图片`);
      if (currentUploads.reduce((total, file) => total + file.size, 0) + files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) {
        throw new Error('附件与内嵌图片总大小不能超过 20 MiB');
      }
      const added: Upload[] = [];
      try {
        for (const file of files) {
          const data = new FormData();
          data.append('file', file);
          added.push(await api<Upload>('/uploads', { method: 'POST', body: data }));
        }
        return { added, insertInline };
      } catch (failure) {
        await Promise.allSettled(added.map(file => api(`/uploads/${file.id}`, { method: 'DELETE' })));
        throw failure;
      }
    },
    onSuccess: ({ added, insertInline }) => {
      setError('');
      setUploads(current => [...current, ...added]);
      if (insertInline && editor && !plainMode) {
        const nodes = added.map(file => ({
          type: 'image',
          attrs: { src: `/api/uploads/${file.id}?inline=1`, alt: file.filename },
        }));
        editor.chain().focus().insertContent(nodes).run();
        setInlineIds(extractEditorInlineUploadIds(editor.getHTML()));
      }
      markChanged();
    },
  });
  const uploadRef = useRef(uploadFiles.mutate);
  uploadRef.current = uploadFiles.mutate;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer', target: null, class: null } },
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ allowBase64: false, inline: false }),
      Placeholder.configure({ placeholder: '输入邮件正文… 支持粘贴截图、Markdown 或拖拽附件' }),
    ],
    content: initialHtml(draft),
    onUpdate: ({ editor: ed }) => {
      setInlineIds(extractEditorInlineUploadIds(ed.getHTML()));
      markChanged();
    },
    editorProps: {
      scrollMargin: { top: 28, right: 12, bottom: 36, left: 12 },
      scrollThreshold: { top: 28, right: 12, bottom: 36, left: 12 },
      attributes: { 'aria-label': '邮件正文', role: 'textbox', 'aria-multiline': 'true' },
      transformPastedHTML: cleanEditorHtml,
      handlePaste: (view, event) => {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;
        const imageFiles = [...clipboard.files].filter(file => INLINE_IMAGE_MIME.test(file.type));
        if (imageFiles.length) {
          event.preventDefault();
          uploadRef.current({ files: imageFiles, insertInline: true });
          return true;
        }
        const htmlData = clipboard.getData('text/html');
        const textData = clipboard.getData('text/plain');
        if (!htmlData && textData && looksLikeMarkdown(textData)) {
          const converted = cleanEditorHtml(markdownToHtml(textData));
          if (converted && editor) {
            event.preventDefault();
            editor.chain().focus().insertContent(converted).run();
            return true;
          }
        }
        return false;
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false;
        const dropped = [...(event.dataTransfer?.files ?? [])];
        if (!dropped.length) return false;
        event.preventDefault();
        const images = dropped.filter(file => INLINE_IMAGE_MIME.test(file.type));
        const others = dropped.filter(file => !INLINE_IMAGE_MIME.test(file.type));
        if (images.length) uploadRef.current({ files: images, insertInline: true });
        if (others.length) uploadRef.current({ files: others, insertInline: false });
        return true;
      },
    },
  });

  // Place initial focus where the user actually starts typing: To field for new/forward, top of body for reply.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusedOnce.current || minimized || !editor) return;
    if (draft && draft.to.trim()) {
      focusedOnce.current = true;
      requestAnimationFrame(() => editor.commands.focus('start'));
    } else {
      focusedOnce.current = true;
    }
  }, [draft, editor, minimized]);

  function persist(content: DraftInput): Promise<Draft> {
    const run = saving.current.catch(() => undefined).then(async () => {
      const id = draftId.current;
      let result: Draft;
      try { result = await api<Draft>(id ? `/drafts/${id}` : '/drafts', json(id ? 'PUT' : 'POST', content)); }
      catch (failure) {
        if (!id || !(failure instanceof ApiError) || failure.status !== 404) throw failure;
        result = await api<Draft>('/drafts', json('POST', content));
      }
      draftId.current = result.id;
      setSaved(true);
      refreshLists();
      return result;
    });
    saving.current = run;
    return run;
  }

  const save = useMutation({
    mutationFn: async (content: DraftInput) => {
      const at = revision.current;
      const result = await persist(content);
      if (revision.current === at) setDirty(false);
      setStatus('草稿已保存');
      return result;
    },
  });

  const send = useMutation({
    mutationFn: async (content: DraftInput) => {
      const toList = parseRecipients(content.to).map(item => item.address);
      const ccList = parseRecipients(content.cc).map(item => item.address);
      const bccList = parseRecipients(content.bcc).map(item => item.address);
      const parsed = sendSchema.safeParse({ ...content, to: toList, cc: ccList, bcc: bccList });
      if (!parsed.success) throw new Error(describeIssues(parsed.error.issues, labels));
      const result = await save.mutateAsync(content);
      return api<{ messageId: string; warning?: string }>('/send', json('POST', { ...parsed.data, draftId: result.id }));
    },
    onSuccess: result => {
      refreshLists();
      onSent(result.warning ?? '邮件已发送', !!result.warning);
      onClose();
    },
  });

  const discard = useMutation({
    mutationFn: async () => {
      await saving.current.catch(() => undefined);
      const id = draftId.current;
      if (id) await api(`/drafts/${id}`, { method: 'DELETE' }).catch(failure => {
        if (!(failure instanceof ApiError) || failure.status !== 404) throw failure;
      });
      await Promise.allSettled(uploads.map(file => api(`/uploads/${file.id}`, { method: 'DELETE' })));
    },
    onSuccess: () => { refreshLists(); onClose(); },
  });

  // Only sending or discarding locks typing; uploading files or saving drafts never interrupts editing.
  const locked = send.isPending || discard.isPending;
  const submittingBlocked = locked || uploadFiles.isPending;

  useEffect(() => { editor?.setEditable(!locked, false); }, [editor, locked]);

  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  const readCurrent = useCallback(() => {
    const html = plainMode ? undefined : (editor?.getHTML() ?? '');
    const text = plainMode ? plainText : (editor?.getText({ blockSeparator: '\n\n' }) ?? '');
    const currentInlineIds = plainMode ? [] : extractEditorInlineUploadIds(html ?? '');
    const attachmentIds = [...new Set([...visibleAttachments.map(file => file.id), ...currentInlineIds])];
    return draftSchema.safeParse({
      accountId: senderId,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      inReplyTo: draft?.inReplyTo,
      references: draft?.references ?? [],
      attachmentIds,
    });
  }, [plainMode, editor, plainText, visibleAttachments, senderId, to, cc, bcc, subject, draft?.inReplyTo, draft?.references]);

  // True idle debounce driven by `changeTick`: skipping an empty draft never disables future autosaves.
  useEffect(() => {
    if (!dirty || locked || uploadFiles.isPending || asking || changeTick === 0) return;
    const timer = setTimeout(() => {
      const content = readCurrent();
      if (!content.success || isEmptyDraft(content.data)) return;
      const at = revision.current;
      persist(content.data).then(
        () => {
          if (revision.current === at) setDirty(false);
          setStatus('已自动保存');
        },
        () => setStatus('自动保存失败，请手动保存草稿'),
      );
    }, 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persist only reads refs and stable query invalidation.
  }, [changeTick, dirty, locked, uploadFiles.isPending, asking, readCurrent]);

  function validateInput(): DraftInput | null {
    const parsed = readCurrent();
    if (!parsed.success) { setError(describeIssues(parsed.error.issues, labels)); return null; }
    setError('');
    return parsed.data;
  }

  function saveCurrent(closeAfter = false) {
    if (submittingBlocked) return;
    const content = validateInput();
    if (content) save.mutate(content, { onSuccess: () => { if (closeAfter) onClose(); } });
    setAsking(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingBlocked) return;
    if (!canSend) { setError('此邮箱已关闭发信，请更换发件人或开启发信。'); return; }
    const content = validateInput();
    if (!content) return;
    if (!content.subject.trim()) { pendingSendRef.current = content; setAsking('no-subject'); return; }
    send.mutate(content);
  }

  function requestClose() {
    if (locked) return;
    if (dirty) {
      if (minimized) onMinimizedChange?.(false);
      setAsking('close');
      return;
    }
    if (fresh && revision.current === 0) { discard.mutate(); return; }
    onClose();
  }

  function closeWithoutSaving() {
    setAsking(null);
    if (draftId.current) onClose(); else discard.mutate();
  }

  function shortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); if (!submittingBlocked) form.current?.requestSubmit(); }
    if (event.key.toLowerCase() === 's') { event.preventDefault(); if (!submittingBlocked) saveCurrent(); }
  }

  function removeAttachment(file: Upload) {
    setUploads(current => current.filter(item => item.id !== file.id));
    markChanged();
    void api(`/uploads/${file.id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  function togglePlainMode() {
    if (plainMode) {
      editor?.commands.setContent(plainTextToHtml(plainText), { emitUpdate: false });
      setInlineIds([]);
      setPlainMode(false);
    } else {
      setPlainText(editor?.getText({ blockSeparator: '\n\n' }) ?? '');
      setPlainMode(true);
    }
    markChanged();
  }

  function handleContainerDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragDepth.current++;
    setDragging(true);
  }
  function handleContainerDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function handleContainerDrop(event: DragEvent<HTMLDivElement>) {
    dragDepth.current = 0;
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    event.preventDefault();
    uploadFiles.mutate({ files, insertInline: false });
  }

  const titleText = draft && !fresh ? '编辑草稿' : '写邮件';
  const dockTitle = subject.trim() || (to.trim() ? `写给 ${parseRecipients(to)[0]?.name || parseRecipients(to)[0]?.address}` : titleText);
  const activeError = error || send.error?.message || save.error?.message || uploadFiles.error?.message || discard.error?.message;
  const statusText = uploadFiles.isPending
    ? '正在上传文件…'
    : save.isPending
      ? '正在保存草稿…'
      : dirty
        ? '有未保存的修改'
        : status;

  return <>
    {minimized && (
      <div className="composer-dock" role="region" aria-label="最小化的写邮件窗口">
        <button type="button" className="composer-dock-open" onClick={() => onMinimizedChange?.(false)}>
          <span className="composer-dock-title">{dockTitle}</span>
          {statusText && <small>{statusText}</small>}
        </button>
        <Button type="button" variant="ghost" aria-label="还原写邮件窗口" title="还原" onClick={() => onMinimizedChange?.(false)}>
          <Maximize2 size={15} aria-hidden />
        </Button>
        <Button type="button" variant="ghost" aria-label="关闭写邮件窗口" title="关闭" disabled={locked} onClick={requestClose}>
          <X size={16} aria-hidden />
        </Button>
      </div>
    )}

    <Dialog.Root open={!minimized} onOpenChange={open => { if (!open && !asking && !locked) requestClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal composer-modal${expanded ? ' composer-expanded' : ''}`}
          onPointerDownOutside={event => event.preventDefault()}
          onInteractOutside={event => event.preventDefault()}
          onEscapeKeyDown={event => {
            if (asking || locked) { event.preventDefault(); return; }
            // Let open toolbar popovers or autocomplete dismiss before closing the composer.
            if (document.querySelector('.toolbar-popover:popover-open')) { event.preventDefault(); return; }
          }}
          aria-describedby={undefined}
        >
          <div className="composer-header">
            <Dialog.Title>{titleText}</Dialog.Title>
            <div className="composer-window-controls">
              {onMinimizedChange && (
                <Button type="button" variant="ghost" aria-label="最小化以便查看其他邮件" title="最小化" onClick={() => onMinimizedChange(true)}>
                  <Minus size={16} aria-hidden />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className="composer-expand-btn"
                aria-label={expanded ? '退出宽屏' : '宽屏编辑'}
                title={expanded ? '退出宽屏' : '宽屏编辑'}
                onClick={() => setExpanded(value => !value)}
              >
                {expanded ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
              </Button>
              <Button type="button" variant="ghost" aria-label="关闭" title="关闭" disabled={locked} onClick={requestClose}>
                <X size={18} aria-hidden />
              </Button>
            </div>
          </div>

          <form ref={form} className="composer-form" onSubmit={submit} onKeyDown={shortcut}>
            <div className="composer-meta">
              <div className="composer-row">
                <label htmlFor="composer-from" className="composer-row-label">发件人</label>
                <div className="composer-row-control">
                  <select
                    id="composer-from"
                    name="accountId"
                    disabled={locked}
                    value={senderId}
                    onChange={event => { setSenderId(event.target.value); markChanged(); }}
                  >
                    {accounts.map(account => (
                      <option key={account.id} value={account.id}>
                        {account.name} &lt;{account.email}&gt;{!account.sendEnabled ? '（发信已关闭）' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {!canSend && <p className="hint composer-meta-hint">此邮箱已关闭发信，可保存草稿或更换发件人。</p>}

              <div className="composer-row">
                <label htmlFor="composer-to" className="composer-row-label">收件人</label>
                <div className="composer-row-control composer-row-inline">
                  <RecipientInput
                    id="composer-to"
                    label="收件人"
                    value={to}
                    disabled={locked}
                    autoFocus={!draft || !draft.to.trim()}
                    placeholder="输入邮箱后回车，支持多地址粘贴"
                    onChange={next => { setTo(next); markChanged(); }}
                  />
                  {!showCopies && (
                    <button type="button" className="link-button composer-cc-toggle" onClick={() => setShowCopies(true)}>
                      抄送/密送
                    </button>
                  )}
                </div>
              </div>

              {showCopies && <>
                <div className="composer-row">
                  <label htmlFor="composer-cc" className="composer-row-label">抄送</label>
                  <div className="composer-row-control">
                    <RecipientInput
                      id="composer-cc"
                      label="抄送"
                      value={cc}
                      disabled={locked}
                      placeholder="抄送地址"
                      onChange={next => { setCc(next); markChanged(); }}
                    />
                  </div>
                </div>
                <div className="composer-row">
                  <label htmlFor="composer-bcc" className="composer-row-label">密送</label>
                  <div className="composer-row-control">
                    <RecipientInput
                      id="composer-bcc"
                      label="密送"
                      value={bcc}
                      disabled={locked}
                      placeholder="密送地址（不会显示给其他收件人）"
                      onChange={next => { setBcc(next); markChanged(); }}
                    />
                  </div>
                </div>
              </>}

              <div className="composer-row">
                <label htmlFor="composer-subject" className="composer-row-label">主题</label>
                <div className="composer-row-control">
                  <input
                    id="composer-subject"
                    name="subject"
                    disabled={locked}
                    value={subject}
                    placeholder="输入邮件主题"
                    onChange={event => { setSubject(event.target.value); markChanged(); }}
                  />
                </div>
              </div>
            </div>

            <EditorToolbar
              editor={editor}
              plainMode={plainMode}
              disabled={locked}
              uploading={uploadFiles.isPending}
              onTogglePlainMode={togglePlainMode}
              onPickAttachment={() => fileInput.current?.click()}
              onPickInlineImage={() => imageInput.current?.click()}
            />

            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={event => {
                const files = [...(event.target.files ?? [])];
                event.target.value = '';
                if (files.length) uploadFiles.mutate({ files, insertInline: false });
              }}
            />
            <input
              ref={imageInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={event => {
                const files = [...(event.target.files ?? [])].filter(file => INLINE_IMAGE_MIME.test(file.type));
                event.target.value = '';
                if (files.length) uploadFiles.mutate({ files, insertInline: true });
              }}
            />

            <div
              ref={scrollRef}
              className={`composer-scroll${dragging ? ' dragging' : ''}`}
              onDragEnter={handleContainerDragEnter}
              onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
              onDragLeave={handleContainerDragLeave}
              onDrop={handleContainerDrop}
              onMouseDown={event => {
                // Clicking empty whitespace below short content focuses the end of the editor naturally.
                if (!plainMode && editor && event.target === scrollRef.current) {
                  event.preventDefault();
                  editor.commands.focus('end');
                }
              }}
            >
              {plainMode ? (
                <textarea
                  className="composer-plain-textarea"
                  aria-label="邮件纯文本正文"
                  disabled={locked}
                  value={plainText}
                  placeholder="输入纯文本邮件正文…"
                  onChange={event => { setPlainText(event.target.value); markChanged(); }}
                />
              ) : (
                <EditorContent editor={editor} className="composer-editor-host" />
              )}
              {dragging && (
                <div className="composer-drop-hint" aria-hidden>
                  <UploadIcon size={24} />
                  <span>松开鼠标添加附件或插入图片</span>
                </div>
              )}
            </div>

            {visibleAttachments.length > 0 && (
              <div className="composer-attachments-bar">
                <ul className="compose-attachments" role="list">
                  {visibleAttachments.map(file => (
                    <li key={file.id}>
                      <Paperclip size={13} aria-hidden />
                      <a href={`/api/uploads/${file.id}`} download={file.filename} title={file.filename}>
                        <FileName name={file.filename} />
                      </a>
                      <small>{fileSize(file.size)}</small>
                      <button type="button" disabled={locked} aria-label={`移除附件 ${file.filename}`} onClick={() => removeAttachment(file)}>
                        <X size={14} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="composer-footer">
              {activeError && <p className="error" role="alert">{activeError}</p>}
              <div className="compose-status" role="status">
                <span>{statusText}</span>
                <span className="compose-hints">
                  {totalUploadBytes > 0 ? `已用 ${fileSize(totalUploadBytes)} / 20 MB` : '附件上限 20 MB'} · {modKey} + Enter 发送 · {modKey} + S 保存
                </span>
              </div>
              <div className="form-footer">
                <Button type="button" variant="ghost" disabled={locked} onClick={() => setAsking('delete')}>
                  <Trash2 size={16} aria-hidden />{saved ? '删除草稿' : '丢弃'}
                </Button>
                <div className="button-row">
                  <Button type="button" disabled={submittingBlocked} onClick={() => saveCurrent()}>
                    <Save size={16} aria-hidden />{save.isPending ? '保存中…' : '保存草稿'}
                  </Button>
                  <Button type="submit" variant="primary" disabled={submittingBlocked || !canSend}>
                    <Send size={16} aria-hidden />{send.isPending ? '正在发送…' : '发送'}
                  </Button>
                </div>
              </div>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    {asking === 'close' && <Modal title="保存这封邮件吗？" description={saved ? '上次保存之后还有修改。' : '这封邮件还没有保存。'} dismissible={!locked} onClose={() => setAsking(null)}>
      <div className="button-row confirm-actions">
        <Button onClick={() => setAsking(null)}>继续编辑</Button>
        <Button onClick={closeWithoutSaving}>{saved ? '不保存最近的修改' : '不保存'}</Button>
        <Button variant="primary" autoFocus onClick={() => saveCurrent(true)}>保存草稿并关闭</Button>
      </div>
    </Modal>}
    {asking === 'no-subject' && <ConfirmModal title="这封邮件没有主题，仍然发送吗？" description="收件人看到时主题将显示为空。"
      confirmLabel="仍然发送" cancelLabel="回去填写主题" variant="primary"
      onClose={() => { pendingSendRef.current = null; setAsking(null); }}
      onConfirm={() => { const data = pendingSendRef.current; pendingSendRef.current = null; setAsking(null); if (data) send.mutate(data); }} />}
    {asking === 'delete' && <ConfirmModal title="删除这封邮件？" description="邮件内容、已保存的草稿和添加的附件都会删除，无法恢复。"
      confirmLabel="删除" cancelLabel="取消" variant="danger"
      onClose={() => setAsking(null)} onConfirm={() => { setAsking(null); discard.mutate(); }} />}
  </>;
}
