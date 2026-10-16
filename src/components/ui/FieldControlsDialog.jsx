import { useEffect, useRef } from 'react';

const FieldControlsDialog = ({ busy = false, children, onOpenChange }) => {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    closeButtonRef.current.focus();
  }, []);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onOpenChange]);

  return (
    <div
      id="field-controls-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="field-controls-title"
      aria-busy={busy}
      className="fixed inset-x-0 bottom-0 z-50 flex min-h-32 max-h-[82dvh] flex-col overflow-hidden rounded-t-xl border border-white/10 bg-black/90 pb-[env(safe-area-inset-bottom)] text-white shadow-2xl backdrop-blur-xl overscroll-contain md:inset-y-3 md:left-auto md:right-3 md:max-h-none md:w-[24rem] md:rounded-xl md:pb-0"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2">
        <h2 id="field-controls-title" className="min-w-0 text-sm font-semibold">
          Field controls
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Close debug drawer"
          onClick={() => onOpenChange(false)}
          className="ml-auto min-h-11 rounded-md border border-white/10 bg-white/5 px-3 text-sm hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          Close
        </button>
      </div>
      {children}
    </div>
  );
};

export default FieldControlsDialog;
