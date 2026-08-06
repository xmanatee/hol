import { selectCoherentObservations } from './anchor.reconstructionRobust.js';

const CONSENSUS_OPTION_FIELDS = [
  'minInliers',
  'threshold',
  'minInlierRatio',
  'model',
  'maxSample',
  'sampleCoverage',
];

const sameObservationSequence = (left, right) =>
  left.length === right.length && left.every((observation, index) => observation === right[index]);

const sameConsensusOptions = (left, right) =>
  CONSENSUS_OPTION_FIELDS.every((field) => Object.is(left[field], right[field]));

const snapshotConsensusOptions = (options) =>
  Object.fromEntries(CONSENSUS_OPTION_FIELDS.map((field) => [field, options[field]]));

export const evaluateFrameConsensus = (previous, observations, options) => {
  if (
    previous &&
    sameObservationSequence(previous.observations, observations) &&
    sameConsensusOptions(previous.options, options)
  ) {
    return previous;
  }

  return {
    observations: [...observations],
    options: snapshotConsensusOptions(options),
    result: selectCoherentObservations(observations, options),
  };
};
