const assertObject = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
};

const assertExactKeys = (value, allowed, name) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field: ${key}`);
  }
};

const requireFiniteCoordinate = (value, name) => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};

const validateTrack = (value, index, frameCount) => {
  const owner = `tracks[${index}]`;
  const track = assertObject(value, owner);
  assertExactKeys(track, new Set(['id', 'queryFrame', 'points', 'occluded']), owner);
  if (typeof track.id !== 'string' || track.id === '' || track.id !== track.id.trim()) {
    throw new TypeError(`${owner}.id must be a non-empty trimmed string`);
  }
  if (!Number.isInteger(track.queryFrame) || track.queryFrame < 0 || track.queryFrame >= frameCount) {
    throw new TypeError(`${owner}.queryFrame must identify a fixture frame`);
  }
  if (!Array.isArray(track.points) || track.points.length !== frameCount) {
    throw new TypeError(`${owner}.points must contain exactly ${frameCount} frames`);
  }
  if (!Array.isArray(track.occluded) || track.occluded.length !== frameCount) {
    throw new TypeError(`${owner}.occluded must contain exactly ${frameCount} frames`);
  }
  const occluded = track.occluded.map((occlusionFlag, frameIndex) => {
    if (typeof occlusionFlag !== 'boolean') {
      throw new TypeError(`${owner}.occluded[${frameIndex}] must be a boolean`);
    }
    return occlusionFlag;
  });
  const points = track.points.map((point, frameIndex) => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new TypeError(`${owner}.points[${frameIndex}] must be an [x, y] pair`);
    }
    const normalizedPoint = [
      requireFiniteCoordinate(point[0], `${owner}.points[${frameIndex}][0]`),
      requireFiniteCoordinate(point[1], `${owner}.points[${frameIndex}][1]`),
    ];
    if (
      !occluded[frameIndex] &&
      (normalizedPoint[0] < 0 || normalizedPoint[0] > 1 || normalizedPoint[1] < 0 || normalizedPoint[1] > 1)
    ) {
      throw new TypeError(`${owner}.points[${frameIndex}] must be inside the visible raster`);
    }
    return normalizedPoint;
  });
  const firstVisibleFrame = occluded.findIndex((occlusionFlag) => !occlusionFlag);
  if (firstVisibleFrame === -1) throw new TypeError(`${owner} must contain a visible frame`);
  if (track.queryFrame !== firstVisibleFrame) {
    throw new TypeError(`${owner}.queryFrame must be the first visible frame`);
  }

  return { id: track.id, queryFrame: track.queryFrame, points, occluded };
};

export const validateTapVidAnnotations = (value, { frameCount }) => {
  if (!Number.isInteger(frameCount) || frameCount < 2) {
    throw new TypeError('frameCount must be an integer greater than or equal to 2');
  }
  const annotations = assertObject(value, 'annotations');
  assertExactKeys(annotations, new Set(['version', 'coordinateSpace', 'tracks']), 'annotations');
  if (annotations.version !== 1) throw new TypeError('annotations.version must be 1');
  if (annotations.coordinateSpace !== 'normalized-raster') {
    throw new TypeError('annotations.coordinateSpace must be normalized-raster');
  }
  if (!Array.isArray(annotations.tracks) || annotations.tracks.length === 0) {
    throw new TypeError('annotations.tracks must be a non-empty array');
  }
  const tracks = annotations.tracks.map((track, index) => validateTrack(track, index, frameCount));
  if (new Set(tracks.map((track) => track.id)).size !== tracks.length) {
    throw new TypeError('TAP-Vid track ids must be unique');
  }
  return { version: 1, coordinateSpace: 'normalized-raster', tracks };
};

export const selectTapVidTracks = (annotations, trackIds) => {
  const tracksById = new Map(annotations.tracks.map((track) => [track.id, track]));
  return trackIds.map((id) => {
    const track = tracksById.get(id);
    if (!track) throw new Error(`Selected TAP-Vid track is absent: ${id}`);
    return track;
  });
};
