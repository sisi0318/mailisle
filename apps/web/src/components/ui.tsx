import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Check, Copy, X } from 'lucide-react';
import { splitFileName } from '../format';

declare module 'react' {
  interface HTMLAttributes<T> {
    focusgroup?: string;
  }
  interface ButtonHTMLAttributes<T> {
    command?: string;
    commandfor?: string;
  }
  interface InputHTMLAttributes<T> {
    switch?: string | boolean;
  }
}

const button = cva('button', { variants: { variant: { primary: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' } }, defaultVariants: { variant: 'secondary' } });
export function Button({ className, variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button> & { ref?: Ref<HTMLButtonElement> }) {
  return <button className={twMerge(clsx(button({ variant }), className))} {...props} />;
}

type ModalProps = { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string; dismissible?: boolean };

/** `onClose` is a request: the dialog stays open unless the caller unmounts it, so callers can ask before discarding input. */
export function Modal({ title, description, children, onClose, wide = false, className, dismissible = true }: ModalProps) {
  return <Dialog.Root open onOpenChange={open => { if (!open && dismissible) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className={clsx('modal', wide && 'modal-wide', className)}
        onPointerDownOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { if (!dismissible) event.preventDefault(); }}
        {...(description ? {} : { 'aria-describedby': undefined })}>
        <div className="modal-heading">
          <div>
            <Dialog.Title>{title}</Dialog.Title>
            {description && <Dialog.Description>{description}</Dialog.Description>}
          </div>
          <Dialog.Close asChild><Button variant="ghost" aria-label="关闭" onClick={() => { if (!dismissible) onClose(); }}><X size={20} aria-hidden /></Button></Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

type ConfirmModalProps = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/** Destructive and guard confirmation dialog that places initial focus on the safe cancel action. */
export function ConfirmModal({ title, description, confirmLabel = '确定', cancelLabel = '取消', variant = 'danger', pending = false, onConfirm, onClose }: ConfirmModalProps) {
  return <Dialog.Root open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content role="alertdialog" className="modal confirm-modal" onPointerDownOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { if (pending) event.preventDefault(); }}
        {...(description ? {} : { 'aria-describedby': undefined })}>
        <div className="modal-heading">
          <div>
            <Dialog.Title>{title}</Dialog.Title>
            {description && <Dialog.Description>{description}</Dialog.Description>}
          </div>
          <Dialog.Close asChild><Button variant="ghost" aria-label="关闭" disabled={pending}><X size={20} aria-hidden /></Button></Dialog.Close>
        </div>
        <div className="button-row confirm-actions">
          <Button autoFocus disabled={pending} onClick={onClose}>{cancelLabel}</Button>
          <Button variant={variant} disabled={pending} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function visibleToolbarItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, [tabindex]')].filter(el => {
    if (el.closest('[popover], [role="menu"], [focusgroup~="menu"]')) return false;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  });
}

/** Accessible horizontal toolbar using native `focusgroup` with a visible-only roving `tabIndex` fallback. */
export function Toolbar({ className, onKeyDown, onFocusCapture, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if ('focusGroup' in HTMLElement.prototype) return;
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const items = visibleToolbarItems(el);
      if (!items.length) return;
      const active = items.find(item => item.tabIndex === 0) ?? items[0];
      for (const item of items) item.tabIndex = item === active ? 0 : -1;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'class', 'style'] });
    const resize = new ResizeObserver(sync);
    resize.observe(el);
    return () => { observer.disconnect(); resize.disconnect(); };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || 'focusGroup' in HTMLElement.prototype) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('[popover], [role="menu"], [focusgroup~="menu"]')) return;
    const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? 'home' : event.key === 'End' ? 'end' : null;
    if (!dir || !ref.current) return;
    const items = visibleToolbarItems(ref.current);
    const index = items.indexOf(target);
    if (index === -1 || !items.length) return;
    event.preventDefault();
    const nextIndex = dir === 'home' ? 0 : dir === 'end' ? items.length - 1 : (index + dir + items.length) % items.length;
    for (const item of items) item.tabIndex = -1;
    items[nextIndex].tabIndex = 0;
    items[nextIndex].focus();
  }

  function handleFocusCapture(event: React.FocusEvent<HTMLDivElement>) {
    onFocusCapture?.(event);
    if ('focusGroup' in HTMLElement.prototype || !ref.current) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('[popover], [role="menu"], [focusgroup~="menu"]')) return;
    const items = visibleToolbarItems(ref.current);
    if (!items.includes(target)) return;
    for (const item of items) item.tabIndex = item === target ? 0 : -1;
  }

  return <div ref={ref} role="toolbar" focusgroup="toolbar wrap" className={clsx('toolbar', className)}
    onKeyDown={handleKeyDown} onFocusCapture={handleFocusCapture} {...props}>{children}</div>;
}

/** Displays a file name with middle truncation so the extension remains legible. */
export function FileName({ name, className }: { name: string; className?: string }) {
  const { stem, ext } = splitFileName(name);
  return <span className={clsx('filename', className)}><span className="filename-stem">{stem}</span>{ext}</span>;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;inset-block-start:-9999px';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

type CopyButtonProps = {
  targetId: string;
  label?: string;
  feedback?: string;
  className?: string;
  variant?: VariantProps<typeof button>['variant'];
  disabled?: boolean;
  children?: ReactNode;
};

/** Copies text from `targetId` using Invoker Commands where supported and announces status in an adjacent live region. */
export function CopyButton({ targetId, label, feedback = '已复制', className, variant = 'secondary', disabled = false, children = '复制' }: CopyButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const lastTipRef = useRef('');
  const [copied, setCopied] = useState(false);
  const [tip, setTip] = useState('');

  const runCopy = useCallback(async () => {
    const text = document.getElementById(targetId)?.textContent ?? '';
    if (!text) return;
    const ok = await copyText(text);
    window.clearTimeout(timerRef.current);
    const base = ok ? feedback : '复制失败';
    const next = lastTipRef.current === base ? `${base}\u00A0` : base;
    lastTipRef.current = next;
    setCopied(ok);
    setTip(next);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      setTip('');
    }, 2000);
  }, [targetId, feedback]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!('CommandEvent' in window)) return;
    const onCommand = (event: Event) => {
      const cmd = event as Event & { command?: string; source?: EventTarget | null };
      if (cmd.command !== '--copy' || cmd.source !== buttonRef.current) return;
      void runCopy();
    };
    document.addEventListener('command', onCommand, true);
    return () => document.removeEventListener('command', onCommand, true);
  }, [runCopy]);

  return <span className="copy-action">
    <Button ref={buttonRef} type="button" variant={variant} className={className} aria-label={label} disabled={disabled}
      command="--copy" commandfor={targetId} onClick={() => { if (!('CommandEvent' in window)) void runCopy(); }}>
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      {children}
    </Button>
    <span className="copy-tip" role="status" data-visible={tip ? '' : undefined}>{tip}</span>
  </span>;
}

export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
