import fs from 'node:fs';
import path from 'node:path';
import parser from '@babel/parser';

const ROOTS = ['src/services', 'src/cv', 'src/utils', 'src/views'];
const IMPORTANT_OPTIONS = new Set([
  'maxRadius',
  'allowExpansion',
  'adaptive',
  'minNewKeypoints',
  'objectSupportMask',
  'createdAtFrame',
  'segmentationRefreshReason',
  'segmentationRefreshFrame',
  'landmarkRefreshReason',
  'showObjectSupport',
  'trackedPoints',
  'trackingMode',
  'imageData',
  'tapPosition',
  'referencePoint',
  'position',
  'radius',
  'reason',
]);
const STRICT_OPTIONS_WITHOUT_DEFAULTS = new Set([
  'imageData',
  'objectSupportMask',
  'position',
  'referencePoint',
  'tapPosition',
  'trackingMode',
]);
const ALLOWED_OMISSIONS = [
  {
    callFile: 'src/services/AnchorManager.js',
    callee: '_segmentTapObject',
    definitionFile: 'src/services/AnchorManager.js',
    missing: 'maxRadius',
  },
  {
    callFile: 'src/services/AnchorManager.js',
    callee: 'createTapLocalObjectSupportMask',
    definitionFile: 'src/cv/objectSupportMask.js',
    missing: 'radius',
  },
  {
    callFile: 'src/services/ImageAnchorService.js',
    callee: '_calculateObjectEvidence',
    definitionFile: 'src/services/ImageAnchorService.js',
    missing: 'trackedPoints',
  },
  {
    callFile: 'src/services/ImageAnchorService.js',
    callee: 'update',
    definitionFile: 'src/cv/objectSurfaceModel.js',
    missing: 'objectSupportMask',
  },
  {
    callFile: 'src/services/ImageAnchorService.js',
    callee: 'createTapLocalObjectSupportMask',
    definitionFile: 'src/cv/objectSupportMask.js',
    missing: 'radius',
  },
];
const REQUIRED_DIAGNOSTICS = [
  'segmentationRefreshReason',
  'segmentationRefreshFrame',
  'landmarkRefreshReason',
  'landmarkRefreshAdded',
  'landmarkRefreshTotal',
  'landmarkRefreshRejectedByMask',
  'trackingRegion',
  'objectSupportMaskBounds',
  'currentObjectSupportMaskBounds',
  'reconstructionRegion',
  'poseRejectedReason',
  'poseSourceHoldReason',
  'reconstructionPoseRejectedReason',
  'surfaceCoverage',
  'surfacePrior',
  'surfaceLockedLandmarks',
  'surfaceContourSegments',
  'silhouetteCoverage',
  'contourFitResidual',
  'landmarksInsideMask',
  'landmarksOutsideMask',
  'occlusionState',
  'poseCandidateSource',
  'poseCandidateScore',
  'rejectedPoseCandidates',
];

const files = [];
const walkFiles = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath);
    } else if (/\.(js|jsx)$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
};
ROOTS.forEach(walkFiles);

const functionOptions = new Map();
const defaultedImportantOptions = [];
const calls = [];

const nodeLocation = (node, file) => `${file}:${node.loc?.start?.line || '?'}`;
const locationFile = loc => loc.slice(0, loc.lastIndexOf(':'));
const omissionIsAllowed = ({ call, definition, missing }) => ALLOWED_OMISSIONS.some(rule => (
  rule.callFile === locationFile(call.loc) &&
  rule.callee === call.name &&
  rule.definitionFile === locationFile(definition.loc) &&
  rule.missing === missing
));
const keyName = node => {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'NumericLiteral') return String(node.value);
  return null;
};
const calleeName = callee => {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression') return keyName(callee.property);
  return null;
};
const objectPatternKeys = pattern => {
  if (pattern?.type !== 'ObjectPattern') return [];
  return pattern.properties
    .map(prop => prop.type === 'ObjectProperty' ? keyName(prop.key) : null)
    .filter(Boolean);
};
const recordDefaultedImportantOptions = (pattern, file) => {
  if (pattern?.type !== 'ObjectPattern') return;
  for (const prop of pattern.properties) {
    if (prop.type !== 'ObjectProperty' || prop.value?.type !== 'AssignmentPattern') continue;
    const name = keyName(prop.key);
    if (STRICT_OPTIONS_WITHOUT_DEFAULTS.has(name)) {
      defaultedImportantOptions.push({
        option: name,
        loc: nodeLocation(prop, file),
      });
    }
  }
};
const objectExpressionKeys = node => {
  if (node?.type !== 'ObjectExpression') return null;
  return node.properties
    .map(prop => prop.type === 'ObjectProperty' ? keyName(prop.key) : prop.type === 'SpreadElement' ? '...spread' : null)
    .filter(Boolean);
};

const recordFunction = (name, node, file) => {
  if (!name) return;
  node.params?.forEach((param, index) => {
    const target = param.type === 'AssignmentPattern' ? param.left : param;
    recordDefaultedImportantOptions(target, file);
    const keys = objectPatternKeys(target);
    const relevant = keys.filter(key => IMPORTANT_OPTIONS.has(key));
    if (!relevant.length) return;
    const entries = functionOptions.get(name) || [];
    entries.push({ name, index, relevant, loc: nodeLocation(node, file) });
    functionOptions.set(name, entries);
  });
};

const visit = (node, file) => {
  if (!node?.type) return;
  if (node.type === 'FunctionDeclaration') {
    recordFunction(node.id?.name, node, file);
  } else if (node.type === 'ClassMethod' || node.type === 'ObjectMethod') {
    recordFunction(keyName(node.key), node, file);
  } else if (node.type === 'VariableDeclarator' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
    recordFunction(node.id?.name, node.init, file);
  } else if (node.type === 'CallExpression') {
    const name = calleeName(node.callee);
    if (name) {
      calls.push({
        name,
        argKeys: node.arguments.map(objectExpressionKeys),
        loc: nodeLocation(node, file),
      });
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) {
      value.forEach(child => visit(child, file));
    } else if (value?.type) {
      visit(value, file);
    }
  }
};

for (const file of files) {
  const ast = parser.parse(fs.readFileSync(file, 'utf8'), {
    sourceType: 'module',
    plugins: ['jsx'],
  });
  visit(ast, file);
}

const optionOmissions = [];
for (const call of calls) {
  for (const definition of functionOptions.get(call.name) || []) {
    const keys = call.argKeys[definition.index];
    if (!keys || keys.includes('...spread')) continue;
    for (const missing of definition.relevant.filter(key => !keys.includes(key))) {
      if (!omissionIsAllowed({ call, definition, missing })) {
        optionOmissions.push({
          call: call.loc,
          callee: call.name,
          definition: definition.loc,
          missing,
        });
      }
    }
  }
}

const diagnosticsSource = fs.readFileSync('src/utils/anchorDiagnostics.js', 'utf8');
const missingDiagnostics = REQUIRED_DIAGNOSTICS.filter(field => !diagnosticsSource.includes(`metrics.${field}`));

if (optionOmissions.length || defaultedImportantOptions.length || missingDiagnostics.length) {
  console.error(JSON.stringify({ optionOmissions, defaultedImportantOptions, missingDiagnostics }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  checkedFiles: files.length,
  optionOmissions: 0,
  defaultedImportantOptions: 0,
  missingDiagnostics: 0,
}, null, 2));
