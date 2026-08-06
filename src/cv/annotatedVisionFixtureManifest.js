import {
  validateAnnotatedVisionAggregateFloor,
  validateAnnotatedVisionQueryFloor,
} from './annotatedVisionQualityFloor.js';

export const ANNOTATED_VISION_FIXTURE_VERSION = 9;
export const ANNOTATED_VISION_FRAME_ENCODING = 'rgb24-xor-delta-gzip';
export const ANNOTATED_VISION_ANNOTATION_FORMAT = 'tapvid-normalized-v1';
export const ANNOTATED_VISION_RESAMPLER = 'pillow-lanczos-per-channel';
const ANNOTATED_VISION_FIXTURE_LICENSES = new Set(['CC-BY-3.0', 'CC-BY-4.0']);

const RGB_CHANNELS = 3;
const MAX_FIXTURES = 8;
const MAX_QUERY_SETS = 8;
const MAX_QUERIES = 64;
const MAX_SOURCE_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COMPRESSED_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_ANNOTATION_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_RASTER_DIMENSION = 16_384;
export const MAX_ANNOTATED_VISION_DECODED_RGB_BYTES = 256 * 1024 * 1024;

const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const SAFE_ID = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;

const assertObject = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
};

const assertExactKeys = (value, allowed, name) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${name} contains unknown field: ${key}`);
    }
  }
};

const requireString = (value, name) => {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  }
  return value;
};

const requireSafeRelativePath = (value, name) => {
  const path = requireString(value, name);
  if (!SAFE_RELATIVE_PATH.test(path)) {
    throw new TypeError(`${name} must be a safe relative path`);
  }
  return path;
};

const requireHttpsUrl = (value, name) => {
  const text = requireString(value, name);
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError(`${name} must be an HTTPS URL without credentials or a fragment`);
  }
  return text;
};

const requireInteger = (value, name, minimum) => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
};

const requireSourceRasterDimension = (value, name) => {
  const dimension = requireInteger(value, name, 1);
  if (dimension > MAX_SOURCE_RASTER_DIMENSION) {
    throw new TypeError(`${name} must not exceed ${MAX_SOURCE_RASTER_DIMENSION}`);
  }
  return dimension;
};

const requireBoundedByteLength = (value, name, maximum) => {
  const byteLength = requireInteger(value, name, 1);
  if (byteLength > maximum) {
    throw new TypeError(`${name} must not exceed ${maximum} bytes`);
  }
  return byteLength;
};

const requireFrameRate = (value, name) => {
  if (!Number.isFinite(value) || value <= 0 || value > 120) {
    throw new TypeError(`${name} must be greater than 0 and at most 120`);
  }
  return value;
};

const requireSha256 = (value, name) => {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${name} must be a SHA-256 digest`);
  }
  return value;
};

const validateSourceArchive = (value, owner) => {
  const source = assertObject(value, owner);
  assertExactKeys(source, new Set(['url', 'byteLength', 'sha256']), owner);
  return {
    url: requireHttpsUrl(source.url, `${owner}.url`),
    byteLength: requireBoundedByteLength(source.byteLength, `${owner}.byteLength`, MAX_SOURCE_ARCHIVE_BYTES),
    sha256: requireSha256(source.sha256, `${owner}.sha256`),
  };
};

const validateSources = (value, owner) => {
  const sources = assertObject(value, `${owner}.sources`);
  assertExactKeys(sources, new Set(['sampleId', 'video', 'annotations']), `${owner}.sources`);
  return {
    sampleId: requireString(sources.sampleId, `${owner}.sources.sampleId`),
    video: validateSourceArchive(sources.video, `${owner}.sources.video`),
    annotations: validateSourceArchive(sources.annotations, `${owner}.sources.annotations`),
  };
};

const validateProvenanceComponent = (value, owner) => {
  const component = assertObject(value, owner);
  assertExactKeys(component, new Set(['license', 'attribution', 'sourceUrl']), owner);
  if (!ANNOTATED_VISION_FIXTURE_LICENSES.has(component.license)) {
    throw new TypeError(`${owner}.license must be an approved fixture license`);
  }
  return {
    license: component.license,
    attribution: requireString(component.attribution, `${owner}.attribution`),
    sourceUrl: requireHttpsUrl(component.sourceUrl, `${owner}.sourceUrl`),
  };
};

const validateProvenance = (value, owner) => {
  const provenance = assertObject(value, `${owner}.provenance`);
  assertExactKeys(provenance, new Set(['video', 'annotations']), `${owner}.provenance`);
  return {
    video: validateProvenanceComponent(provenance.video, `${owner}.provenance.video`),
    annotations: validateProvenanceComponent(provenance.annotations, `${owner}.provenance.annotations`),
  };
};

const validateFrames = (value, { owner }) => {
  const frames = assertObject(value, `${owner}.frames`);
  assertExactKeys(
    frames,
    new Set(['path', 'encoding', 'width', 'height', 'count', 'framesPerSecond', 'byteLength', 'sha256']),
    `${owner}.frames`,
  );
  if (frames.encoding !== ANNOTATED_VISION_FRAME_ENCODING) {
    throw new TypeError(`${owner}.frames.encoding must be ${ANNOTATED_VISION_FRAME_ENCODING}`);
  }

  const validated = {
    path: requireSafeRelativePath(frames.path, `${owner}.frames.path`),
    encoding: frames.encoding,
    width: requireInteger(frames.width, `${owner}.frames.width`, 1),
    height: requireInteger(frames.height, `${owner}.frames.height`, 1),
    count: requireInteger(frames.count, `${owner}.frames.count`, 2),
    framesPerSecond: requireFrameRate(frames.framesPerSecond, `${owner}.frames.framesPerSecond`),
    byteLength: requireBoundedByteLength(
      frames.byteLength,
      `${owner}.frames.byteLength`,
      MAX_COMPRESSED_FRAME_BYTES,
    ),
    sha256: requireSha256(frames.sha256, `${owner}.frames.sha256`),
  };
  const decodedByteLength = validated.width * validated.height * validated.count * RGB_CHANNELS;
  if (
    !Number.isSafeInteger(decodedByteLength) ||
    decodedByteLength > MAX_ANNOTATED_VISION_DECODED_RGB_BYTES
  ) {
    throw new TypeError(
      `${owner}.frames decoded RGB payload must not exceed ${MAX_ANNOTATED_VISION_DECODED_RGB_BYTES} bytes`,
    );
  }
  return validated;
};

const validateFrameDerivation = (value, frames, owner) => {
  const derivation = assertObject(value, `${owner}.frameDerivation`);
  const kind = requireString(derivation.kind, `${owner}.frameDerivation.kind`);
  const sourceWidth = requireSourceRasterDimension(
    derivation.sourceWidth,
    `${owner}.frameDerivation.sourceWidth`,
  );
  const sourceHeight = requireSourceRasterDimension(
    derivation.sourceHeight,
    `${owner}.frameDerivation.sourceHeight`,
  );

  if (kind === 'identity') {
    assertExactKeys(derivation, new Set(['kind', 'sourceWidth', 'sourceHeight']), `${owner}.frameDerivation`);
    if (sourceWidth !== frames.width || sourceHeight !== frames.height) {
      throw new TypeError(`${owner}.frameDerivation identity raster must match frames raster`);
    }
    return { kind, sourceWidth, sourceHeight };
  }

  if (kind === 'resize') {
    assertExactKeys(
      derivation,
      new Set(['kind', 'sourceWidth', 'sourceHeight', 'resampler']),
      `${owner}.frameDerivation`,
    );
    if (sourceWidth === frames.width && sourceHeight === frames.height) {
      throw new TypeError(`${owner}.frameDerivation resize must change the source raster`);
    }
    if (derivation.resampler !== ANNOTATED_VISION_RESAMPLER) {
      throw new TypeError(`${owner}.frameDerivation.resampler must be ${ANNOTATED_VISION_RESAMPLER}`);
    }
    return {
      kind,
      sourceWidth,
      sourceHeight,
      resampler: ANNOTATED_VISION_RESAMPLER,
    };
  }

  throw new TypeError(`${owner}.frameDerivation.kind must be identity or resize`);
};

const validateAnnotations = (value, { owner }) => {
  const annotations = assertObject(value, `${owner}.annotations`);
  assertExactKeys(annotations, new Set(['path', 'format', 'byteLength', 'sha256']), `${owner}.annotations`);
  if (annotations.format !== ANNOTATED_VISION_ANNOTATION_FORMAT) {
    throw new TypeError(`${owner}.annotations.format must be ${ANNOTATED_VISION_ANNOTATION_FORMAT}`);
  }

  return {
    path: requireSafeRelativePath(annotations.path, `${owner}.annotations.path`),
    format: annotations.format,
    byteLength: requireBoundedByteLength(
      annotations.byteLength,
      `${owner}.annotations.byteLength`,
      MAX_ANNOTATION_BYTES,
    ),
    sha256: requireSha256(annotations.sha256, `${owner}.annotations.sha256`),
  };
};

const validateQueries = (value, owner) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${owner}.queries must be a non-empty array`);
  }
  if (value.length > MAX_QUERIES) {
    throw new TypeError(`${owner}.queries must contain at most ${MAX_QUERIES} entries`);
  }

  const queries = value.map((item, index) => {
    const queryOwner = `${owner}.queries[${index}]`;
    const query = assertObject(item, queryOwner);
    assertExactKeys(query, new Set(['trackId', 'qualityFloor']), queryOwner);
    return {
      trackId: requireString(query.trackId, `${queryOwner}.trackId`),
      qualityFloor: validateAnnotatedVisionQueryFloor(query.qualityFloor, queryOwner),
    };
  });
  const trackIds = queries.map(({ trackId }) => trackId);
  if (new Set(trackIds).size !== trackIds.length) {
    throw new TypeError(`${owner}.queries must contain unique trackIds`);
  }
  return queries;
};

const validateQuerySets = (value, owner) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${owner}.querySets must be a non-empty array`);
  }
  if (value.length > MAX_QUERY_SETS) {
    throw new TypeError(`${owner}.querySets must contain at most ${MAX_QUERY_SETS} entries`);
  }

  const querySets = value.map((item, index) => {
    const querySetOwner = `${owner}.querySets[${index}]`;
    const querySet = assertObject(item, querySetOwner);
    assertExactKeys(querySet, new Set(['id', 'aggregateFloor', 'queries']), querySetOwner);
    const id = requireString(querySet.id, `${querySetOwner}.id`);
    if (!SAFE_ID.test(id)) {
      throw new TypeError(`${querySetOwner}.id must be a lowercase kebab-case id`);
    }
    return {
      id,
      aggregateFloor: validateAnnotatedVisionAggregateFloor(querySet.aggregateFloor, querySetOwner),
      queries: validateQueries(querySet.queries, querySetOwner),
    };
  });

  const querySetIds = new Set();
  const ownedTrackIds = new Set();
  for (const querySet of querySets) {
    if (querySetIds.has(querySet.id)) {
      throw new TypeError(`Fixture query set id is duplicated: ${querySet.id}`);
    }
    querySetIds.add(querySet.id);
    for (const { trackId } of querySet.queries) {
      if (ownedTrackIds.has(trackId)) {
        throw new TypeError(`Track id is owned by multiple query sets: ${trackId}`);
      }
      ownedTrackIds.add(trackId);
    }
  }
  if (ownedTrackIds.size > MAX_QUERIES) {
    throw new TypeError(`${owner}.querySets must select at most ${MAX_QUERIES} queries in total`);
  }
  return querySets;
};

const validateFixture = (value, index) => {
  const owner = `fixtures[${index}]`;
  const fixture = assertObject(value, owner);
  assertExactKeys(
    fixture,
    new Set([
      'id',
      'dataset',
      'provenance',
      'sources',
      'frameDerivation',
      'frames',
      'annotations',
      'querySets',
    ]),
    owner,
  );
  const id = requireString(fixture.id, `${owner}.id`);
  if (!SAFE_ID.test(id)) throw new TypeError(`${owner}.id must be a lowercase kebab-case id`);
  const frames = validateFrames(fixture.frames, { owner });

  return {
    id,
    dataset: requireString(fixture.dataset, `${owner}.dataset`),
    provenance: validateProvenance(fixture.provenance, owner),
    sources: validateSources(fixture.sources, owner),
    frameDerivation: validateFrameDerivation(fixture.frameDerivation, frames, owner),
    frames,
    annotations: validateAnnotations(fixture.annotations, { owner }),
    querySets: validateQuerySets(fixture.querySets, owner),
  };
};

const assertUniqueOwnership = (fixtures) => {
  const fixtureIds = new Set();
  const assetPaths = new Set();
  for (const fixture of fixtures) {
    if (fixtureIds.has(fixture.id)) throw new TypeError(`Fixture id is duplicated: ${fixture.id}`);
    fixtureIds.add(fixture.id);
    for (const path of [fixture.frames.path, fixture.annotations.path]) {
      if (assetPaths.has(path)) throw new TypeError(`Asset path is owned by multiple fixtures: ${path}`);
      assetPaths.add(path);
    }
  }
};

export const validateAnnotatedVisionFixtureManifest = (value) => {
  const manifest = assertObject(value, 'Annotated vision fixture manifest');
  assertExactKeys(manifest, new Set(['version', 'fixtures']), 'Annotated vision fixture manifest');
  if (manifest.version !== ANNOTATED_VISION_FIXTURE_VERSION) {
    throw new TypeError(
      `Annotated vision fixture manifest version must be ${ANNOTATED_VISION_FIXTURE_VERSION}`,
    );
  }
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    throw new TypeError('Annotated vision fixture manifest must contain a non-empty fixtures array');
  }
  if (manifest.fixtures.length > MAX_FIXTURES) {
    throw new TypeError(`Annotated vision fixture manifest must contain at most ${MAX_FIXTURES} fixtures`);
  }

  const fixtures = manifest.fixtures.map(validateFixture);
  assertUniqueOwnership(fixtures);
  return { version: ANNOTATED_VISION_FIXTURE_VERSION, fixtures };
};

export const summarizeAnnotatedVisionFixtureManifest = (manifest) => {
  const summary = {
    fixtures: manifest.fixtures.length,
    frames: 0,
    independentQueries: 0,
    byDataset: {},
  };
  for (const fixture of manifest.fixtures) {
    summary.frames += fixture.frames.count;
    summary.independentQueries += fixture.querySets.reduce(
      (count, querySet) => count + querySet.queries.length,
      0,
    );
    summary.byDataset[fixture.dataset] = (summary.byDataset[fixture.dataset] || 0) + 1;
  }
  return summary;
};
