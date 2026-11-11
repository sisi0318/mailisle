import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X } from 'lucide-react';

const button = cva('button', { variants: { variant: { primary: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' } }, defaultVariants: { variant: 'secondary' } });
export function Button({ className, variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button> & { ref?: Ref<HTMLButtonElement> }) {
  return <button className={twMerge(clsx(button({ variant }), className))} {...props} />;
}

type ModalProps = { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string };

/** `onClose` is a request: the dialog stays open unless the caller unmounts it, so callers can ask before discarding input. */
export function Modal({ title, description, children, onClose, wide = false, className }: ModalProps) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className={clsx('modal', wide && 'modal-wide', className)} onPointerDownOutside={event => event.preventDefault()}
        {...(description ? {} : { 'aria-describedby': undefined })}>
        <div className="modal-heading">
          <div>
            <Dialog.Title>{title}</Dialog.Title>
            {description && <Dialog.Description>{description}</Dialog.Description>}
          </div>
          <Dialog.Close asChild><Button variant="ghost" aria-label="关闭"><X size={20} aria-hidden /></Button></Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Whether a media query matches right now, kept up to date. */
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
