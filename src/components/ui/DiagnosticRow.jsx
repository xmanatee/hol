import { DynamicText } from './FieldControlPrimitives.jsx';

export const DiagnosticRow = ({ label, value, tone = 'neutral' }) => {
  const toneClass =
    tone === 'bad'
      ? 'text-red-300'
      : tone === 'warn'
        ? 'text-yellow-300'
        : tone === 'good'
          ? 'text-green-300'
          : 'text-gray-300';

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-2 border-b border-gray-800 py-1 last:border-b-0">
      <span className="min-w-0 text-gray-400 [overflow-wrap:anywhere]">{label}</span>
      <DynamicText className={`text-end font-mono ${toneClass}`}>{value}</DynamicText>
    </div>
  );
};
