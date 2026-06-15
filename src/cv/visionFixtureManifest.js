export const REAL_VISION_TASKS = [
  'segmentation',
  'pointTracking',
  'pose3d',
  'reconstruction',
  'detection',
];

const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

const requireString = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

const requireSafeRelativePath = (value, name) => {
  const path = requireString(value, name);
  if (!SAFE_RELATIVE_PATH.test(path)) {
    throw new Error(`${name} must be a safe relative path`);
  }
  return path;
};

const validateTasks = tasks => {
  if (tasks === undefined) {
    return [];
  }
  if (!Array.isArray(tasks)) {
    throw new Error('tasks must be an array');
  }

  return tasks.map(task => {
    if (!REAL_VISION_TASKS.includes(task)) {
      throw new Error(`Unknown real vision task: ${task}`);
    }
    return task;
  });
};

const validateAnnotations = annotations => {
  if (annotations === undefined) {
    return {};
  }
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) {
    throw new Error('annotations must be an object');
  }

  return Object.fromEntries(Object.entries(annotations).map(([name, path]) => [
    name,
    requireSafeRelativePath(path, `annotations.${name}`),
  ]));
};

const annotationPaths = annotations => Object.values(annotations || {});

const validateFixture = (entry, index, { requireUrls }) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`fixtures[${index}] must be an object`);
  }

  const dataset = requireString(entry.dataset, `fixtures[${index}].dataset`);
  const path = requireSafeRelativePath(entry.path, `fixtures[${index}].path`);
  if (!Number.isFinite(entry.minimumBytes) || entry.minimumBytes <= 0) {
    throw new Error(`fixtures[${index}].minimumBytes must be a positive number`);
  }

  const tasks = validateTasks(entry.tasks);
  const annotations = validateAnnotations(entry.annotations);
  const url = entry.url === undefined
    ? undefined
    : requireString(entry.url, `fixtures[${index}].url`);

  if (requireUrls && !url) {
    throw new Error(`fixtures[${index}].url is required`);
  }

  return {
    dataset,
    path,
    minimumBytes: entry.minimumBytes,
    sha256: entry.sha256,
    url,
    tasks,
    annotations,
    annotationPaths: annotationPaths(annotations),
  };
};

export const validateVisionFixtureManifest = (manifest, options = {}) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Real vision fixture manifest must be an object');
  }
  if (!Array.isArray(manifest.fixtures)) {
    throw new Error('Real vision fixture manifest must contain a fixtures array');
  }

  return {
    fixtures: manifest.fixtures.map((entry, index) => validateFixture(entry, index, {
      requireUrls: options.requireUrls === true,
    })),
  };
};

export const summarizeVisionFixtureManifest = manifest => {
  const summary = {
    total: manifest.fixtures.length,
    byDataset: {},
    byTask: {},
    annotationFiles: 0,
  };

  for (const fixture of manifest.fixtures) {
    summary.byDataset[fixture.dataset] = (summary.byDataset[fixture.dataset] || 0) + 1;
    for (const task of fixture.tasks || []) {
      summary.byTask[task] = (summary.byTask[task] || 0) + 1;
    }
    summary.annotationFiles += fixture.annotationPaths?.length || 0;
  }

  return summary;
};
