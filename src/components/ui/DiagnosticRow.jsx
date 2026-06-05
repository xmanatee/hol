export const DiagnosticRow = ({ label, value, tone = 'neutral' }) => {
  const toneClass = tone === 'bad'
    ? 'text-red-300'
    : tone === 'warn'
      ? 'text-yellow-300'
      : tone === 'good'
        ? 'text-green-300'
        : 'text-gray-300';

  return (
    <div className="flex justify-between gap-2 border-b border-gray-800 py-1 last:border-b-0">
      <span className="text-gray-500">{label}</span>
      <span className={`text-right font-mono ${toneClass}`}>{value}</span>
    </div>
  );
};
