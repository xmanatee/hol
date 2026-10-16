import { CircleCheck, LoaderCircle, ScanLine, TriangleAlert } from 'lucide-react';
import { useRef } from 'react';
import { DynamicText } from './FieldControlPrimitives.jsx';
import { cx } from './uiClassNames.js';

export const AnchorStatusMessage = ({ status, error, onRetry }) => {
  const messageRef = useRef(null);
  const loading = status.status === 'initializing';
  const failed = status.status === 'error';
  const Icon = loading
    ? LoaderCircle
    : status.severity === 'bad' || status.severity === 'warn'
      ? TriangleAlert
      : status.severity === 'good'
        ? CircleCheck
        : ScanLine;

  return (
    <div
      ref={messageRef}
      tabIndex={-1}
      role={failed ? 'alert' : 'status'}
      className={cx(
        'min-w-0 rounded-lg border p-3 text-left',
        status.severity === 'bad'
          ? 'border-red-400/40 bg-red-950/90 text-red-100'
          : status.severity === 'good'
            ? 'border-emerald-400/30 bg-emerald-950/90 text-emerald-100'
            : status.severity === 'warn'
              ? 'border-amber-400/40 bg-amber-950/90 text-amber-100'
              : 'border-white/15 bg-zinc-950/90 text-zinc-100',
      )}
    >
      <div className="flex items-start gap-3">
        <Icon
          size={20}
          aria-hidden="true"
          className={cx('mt-0.5 shrink-0', loading && 'animate-spin motion-reduce:animate-none')}
        />
        <div className="min-w-0 space-y-1">
          <DynamicText className="block text-sm font-medium">{status.message}</DynamicText>
          <DynamicText className="block text-xs leading-relaxed opacity-80">
            {status.recommendation}
          </DynamicText>
        </div>
      </div>
      {failed && (
        <>
          <button
            type="button"
            onClick={() => {
              messageRef.current.focus();
              onRetry();
            }}
            className="pointer-events-auto mt-3 min-h-11 w-full rounded-md border border-red-300/50 bg-red-900/60 px-3 text-sm font-medium hover:bg-red-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-100"
          >
            Retry vision
          </button>
          <details className="pointer-events-auto mt-3 text-xs">
            <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-100">
              Technical details
            </summary>
            <DynamicText className="block text-start leading-relaxed opacity-80">{error}</DynamicText>
          </details>
        </>
      )}
    </div>
  );
};
