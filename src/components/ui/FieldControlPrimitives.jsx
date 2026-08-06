import { cx } from './uiClassNames.js';

export const IconButton = ({
  label,
  icon,
  buttonRef,
  active = false,
  tone = 'neutral',
  className = '',
  ...props
}) => {
  const IconComponent = icon;

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'grid h-11 w-11 place-items-center rounded-md border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
        active
          ? 'border-white bg-white text-black'
          : 'border-white/15 bg-black/55 text-white hover:bg-white/10',
        tone === 'danger' && !active ? 'border-red-400/40 text-red-200 hover:bg-red-950/70' : '',
        tone === 'good' && !active ? 'border-emerald-400/40 text-emerald-200 hover:bg-emerald-950/70' : '',
        className,
      )}
      {...props}
    >
      <IconComponent size={18} strokeWidth={2} aria-hidden="true" />
    </button>
  );
};

export const DynamicText = ({ children, className = '' }) => (
  <span dir="auto" className={cx('min-w-0 [overflow-wrap:anywhere]', className)}>
    {children}
  </span>
);

export const MetricPill = ({ label, value, tone = 'neutral' }) => (
  <div
    className={cx(
      'min-w-0 rounded-md border px-2 py-1',
      tone === 'good'
        ? 'border-emerald-400/30 bg-emerald-950/40 text-emerald-100'
        : tone === 'warn'
          ? 'border-yellow-400/30 bg-yellow-950/40 text-yellow-100'
          : tone === 'bad'
            ? 'border-red-400/30 bg-red-950/40 text-red-100'
            : 'border-white/10 bg-white/5 text-gray-200',
    )}
  >
    <DynamicText className="block text-[10px] uppercase text-gray-400">{label}</DynamicText>
    <DynamicText className="block text-xs font-medium">{value}</DynamicText>
  </div>
);

export const DrawerSection = ({ title, children, className = '' }) => (
  <section className={cx('min-w-0 border-b border-white/10 px-4 py-3 last:border-b-0', className)}>
    <h3 className="mb-2 text-xs font-semibold uppercase text-gray-400">{title}</h3>
    {children}
  </section>
);
