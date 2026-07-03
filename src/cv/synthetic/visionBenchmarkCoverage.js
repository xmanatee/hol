const summarizeCounts = values => {
  const total = values.length;
  const countByName = new Map();

  for (const value of values) {
    countByName.set(value, (countByName.get(value) || 0) + 1);
  }

  const rows = [...countByName.entries()]
    .map(([name, count]) => ({
      name,
      count,
      share: total ? count / total : 0,
    }))
    .sort((left, right) => (
      right.count - left.count ||
      left.name.localeCompare(right.name)
    ));
  const counts = rows.map(row => row.count);
  const minCount = counts.length ? Math.min(...counts) : 0;
  const maxCount = counts.length ? Math.max(...counts) : 0;

  return {
    total,
    uniqueCount: rows.length,
    minCount,
    maxCount,
    imbalanceRatio: minCount ? maxCount / minCount : 0,
    values: rows,
  };
};

const scenarioAxisValues = (scenarios, axis) => scenarios.map(scenario => scenario.axes[axis]);

const scenarioInteractionValues = (scenarios, axes) => (
  scenarios.map(scenario => axes.map(axis => scenario.axes[axis]).join(' / '))
);

const replayModeValues = ({ scenarios, modes }) => (
  modes.flatMap(mode => scenarios.map(() => mode.id))
);

const replayModeAxisValues = ({ scenarios, modes, axis }) => (
  modes.flatMap(mode => scenarios.map(scenario => `${mode.id} / ${scenario.axes[axis]}`))
);

const imbalanceRows = groups => Object.entries(groups)
  .map(([name, summary]) => ({
    name,
    total: summary.total,
    uniqueCount: summary.uniqueCount,
    minCount: summary.minCount,
    maxCount: summary.maxCount,
    imbalanceRatio: summary.imbalanceRatio,
  }))
  .filter(row => row.uniqueCount > 1)
  .sort((left, right) => (
    right.imbalanceRatio - left.imbalanceRatio ||
    right.maxCount - left.maxCount
  ));

export const summarizeVisionBenchmarkCoverage = ({ scenarios, modes }) => {
  const scenarioAxes = {
    object: summarizeCounts(scenarioAxisValues(scenarios, 'object')),
    targetClass: summarizeCounts(scenarioAxisValues(scenarios, 'targetClass')),
    geometry: summarizeCounts(scenarioAxisValues(scenarios, 'geometry')),
    background: summarizeCounts(scenarioAxisValues(scenarios, 'background')),
    lighting: summarizeCounts(scenarioAxisValues(scenarios, 'lighting')),
    motion: summarizeCounts(scenarioAxisValues(scenarios, 'motion')),
    occlusion: summarizeCounts(scenarioAxisValues(scenarios, 'occlusion')),
    condition: summarizeCounts(scenarioAxisValues(scenarios, 'condition')),
  };
  const scenarioInteractions = {
    objectBackground: summarizeCounts(scenarioInteractionValues(scenarios, ['object', 'background'])),
    objectOcclusion: summarizeCounts(scenarioInteractionValues(scenarios, ['object', 'occlusion'])),
    motionOcclusion: summarizeCounts(scenarioInteractionValues(scenarios, ['motion', 'occlusion'])),
    geometryMotion: summarizeCounts(scenarioInteractionValues(scenarios, ['geometry', 'motion'])),
    geometryOcclusion: summarizeCounts(scenarioInteractionValues(scenarios, ['geometry', 'occlusion'])),
    targetClassOcclusion: summarizeCounts(scenarioInteractionValues(scenarios, ['targetClass', 'occlusion'])),
  };
  const replayAxes = {
    mode: summarizeCounts(replayModeValues({ scenarios, modes })),
    modeObject: summarizeCounts(replayModeAxisValues({ scenarios, modes, axis: 'object' })),
    modeTargetClass: summarizeCounts(replayModeAxisValues({ scenarios, modes, axis: 'targetClass' })),
    modeGeometry: summarizeCounts(replayModeAxisValues({ scenarios, modes, axis: 'geometry' })),
    modeMotion: summarizeCounts(replayModeAxisValues({ scenarios, modes, axis: 'motion' })),
    modeOcclusion: summarizeCounts(replayModeAxisValues({ scenarios, modes, axis: 'occlusion' })),
  };

  return {
    scenarioCount: scenarios.length,
    modeCount: modes.length,
    replayCount: scenarios.length * modes.length,
    scenarioAxes,
    scenarioInteractions,
    replayAxes,
    imbalances: {
      scenarioAxes: imbalanceRows(scenarioAxes),
      scenarioInteractions: imbalanceRows(scenarioInteractions),
      replayAxes: imbalanceRows(replayAxes),
    },
  };
};
