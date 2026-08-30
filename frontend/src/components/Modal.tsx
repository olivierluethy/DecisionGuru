import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Padding for the scroll body. Override (e.g. `p-0`) when the content manages its own
   *  layout — a modal with a sticky side rail needs the rail flush to the scroll edges. */
  bodyClassName?: string;
  /** Ref to the scroll container, so content can drive scroll-spy against it. */
  bodyRef?: Ref<HTMLDivElement>;
}

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-6xl',
};

export function Modal({ title, subtitle, onClose, children, footer, size = 'md', bodyClassName = 'px-5 py-4', bodyRef }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="fixed inset-0 bg-[rgba(6,9,14,0.66)] backdrop-blur-[2px] animate-fade-in"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative w-full ${SIZES[size]} my-auto bg-surface border border-hairline rounded-lg shadow-modal animate-modal-in outline-none`}
      >
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-hairline">
          <div>
            <h2 className="font-display text-lg font-semibold text-text">{title}</h2>
            {subtitle && <p className="text-sm text-text-muted mt-0.5">{subtitle}</p>}
          </div>
          <button
            className="text-text-faint hover:text-text p-1 -mr-1 rounded"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        <div ref={bodyRef} className={`max-h-[70vh] overflow-y-auto ${bodyClassName}`}>{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-hairline bg-bg-elev/50 rounded-b-lg">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
