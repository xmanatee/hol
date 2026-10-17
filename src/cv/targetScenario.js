export const TARGET_SCENARIOS = Object.freeze(
  [
    {
      id: 'can',
      surfaceHint: 'can',
    },
    {
      id: 'bottle-label',
      surfaceHint: 'bottle',
    },
    {
      id: 'paper',
      surfaceHint: 'paper',
    },
    {
      id: 'general',
      surfaceHint: null,
    },
  ].map(Object.freeze),
);

export const getTargetScenario = (id) => {
  const scenario = TARGET_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) throw new RangeError(`Unsupported target scenario: ${id}`);
  return scenario;
};
