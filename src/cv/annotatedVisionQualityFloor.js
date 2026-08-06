const AGGREGATE_FLOOR_FIELDS = new Set([
  'minimumAverageJaccard',
  'minimumAveragePointsWithinThreshold',
  'minimumOcclusionAccuracy',
  'reDetection',
]);

const QUERY_FLOOR_FIELDS = new Set([
  'minimumAverageJaccard',
  'minimumAveragePointsWithinThreshold',
  'minimumOcclusionAccuracy',
  'maximumP95VisiblePointError',
  'maximumFalseVisibleDurationMs',
  'maximumMissedVisibleDurationMs',
  'maximumVisibleTrackFragmentationCount',
  'reDetection',
]);

const RE_DETECTION_NOT_APPLICABLE_FIELDS = new Set(['kind']);
const RE_DETECTION_SEGMENT_ONLY_FIELDS = new Set(['kind', 'minimumAverageJaccard']);
const RE_DETECTION_ELIGIBLE_FIELDS = new Set([
  'kind',
  'minimumAverageJaccard',
  'minimumStableRecall',
  'maximumStableLatencyMs',
]);

const requireFloorObject = (value, allowedFields, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) throw new TypeError(`${name} contains unknown field: ${key}`);
  }
  return value;
};

const requirePositiveUnitInterval = (value, name) => {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(`${name} must be greater than 0 and at most 1`);
  }
  return value;
};

const requireUnitInterval = (value, name) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be between 0 and 1`);
  }
  return value;
};

const requireNonNegativeFinite = (value, name) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
};

const requireNonNegativeInteger = (value, name) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
};

const validateReDetectionFloor = (value, name, { requirePositiveStableRecall }) => {
  const kind = value?.kind;
  const allowedFields =
    kind === 'eligible'
      ? RE_DETECTION_ELIGIBLE_FIELDS
      : kind === 'segment-only'
        ? RE_DETECTION_SEGMENT_ONLY_FIELDS
        : RE_DETECTION_NOT_APPLICABLE_FIELDS;
  const floor = requireFloorObject(value, allowedFields, name);
  if (!['eligible', 'segment-only', 'not-applicable'].includes(floor.kind)) {
    throw new TypeError(`${name}.kind must be eligible, segment-only, or not-applicable`);
  }
  if (floor.kind === 'not-applicable') return { kind: 'not-applicable' };
  const minimumAverageJaccard = requirePositiveUnitInterval(
    floor.minimumAverageJaccard,
    `${name}.minimumAverageJaccard`,
  );
  if (floor.kind === 'segment-only') return { kind: 'segment-only', minimumAverageJaccard };
  return {
    kind: 'eligible',
    minimumAverageJaccard,
    minimumStableRecall: requirePositiveStableRecall
      ? requirePositiveUnitInterval(floor.minimumStableRecall, `${name}.minimumStableRecall`)
      : requireUnitInterval(floor.minimumStableRecall, `${name}.minimumStableRecall`),
    maximumStableLatencyMs: requireNonNegativeFinite(
      floor.maximumStableLatencyMs,
      `${name}.maximumStableLatencyMs`,
    ),
  };
};

export const validateAnnotatedVisionAggregateFloor = (value, owner) => {
  const floor = requireFloorObject(value, AGGREGATE_FLOOR_FIELDS, `${owner}.aggregateFloor`);
  const name = (field) => `${owner}.aggregateFloor.${field}`;
  return {
    minimumAverageJaccard: requirePositiveUnitInterval(
      floor.minimumAverageJaccard,
      name('minimumAverageJaccard'),
    ),
    minimumAveragePointsWithinThreshold: requirePositiveUnitInterval(
      floor.minimumAveragePointsWithinThreshold,
      name('minimumAveragePointsWithinThreshold'),
    ),
    minimumOcclusionAccuracy: requirePositiveUnitInterval(
      floor.minimumOcclusionAccuracy,
      name('minimumOcclusionAccuracy'),
    ),
    reDetection: validateReDetectionFloor(floor.reDetection, name('reDetection'), {
      requirePositiveStableRecall: true,
    }),
  };
};

export const validateAnnotatedVisionQueryFloor = (value, owner) => {
  const floor = requireFloorObject(value, QUERY_FLOOR_FIELDS, `${owner}.qualityFloor`);
  const name = (field) => `${owner}.qualityFloor.${field}`;
  const reDetection = validateReDetectionFloor(floor.reDetection, `${owner}.qualityFloor.reDetection`, {
    requirePositiveStableRecall: false,
  });
  return {
    minimumAverageJaccard: requirePositiveUnitInterval(
      floor.minimumAverageJaccard,
      name('minimumAverageJaccard'),
    ),
    minimumAveragePointsWithinThreshold: requirePositiveUnitInterval(
      floor.minimumAveragePointsWithinThreshold,
      name('minimumAveragePointsWithinThreshold'),
    ),
    minimumOcclusionAccuracy: requirePositiveUnitInterval(
      floor.minimumOcclusionAccuracy,
      name('minimumOcclusionAccuracy'),
    ),
    maximumP95VisiblePointError: requireNonNegativeFinite(
      floor.maximumP95VisiblePointError,
      name('maximumP95VisiblePointError'),
    ),
    maximumFalseVisibleDurationMs: requireNonNegativeFinite(
      floor.maximumFalseVisibleDurationMs,
      name('maximumFalseVisibleDurationMs'),
    ),
    maximumMissedVisibleDurationMs: requireNonNegativeFinite(
      floor.maximumMissedVisibleDurationMs,
      name('maximumMissedVisibleDurationMs'),
    ),
    maximumVisibleTrackFragmentationCount: requireNonNegativeInteger(
      floor.maximumVisibleTrackFragmentationCount,
      name('maximumVisibleTrackFragmentationCount'),
    ),
    reDetection,
  };
};
