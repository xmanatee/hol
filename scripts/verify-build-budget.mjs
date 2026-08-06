import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_ASSETS = join(fileURLToPath(new URL('../dist', import.meta.url)), 'assets');
const DIST_INDEX = fileURLToPath(new URL('../dist/index.html', import.meta.url));
const STARTUP_JAVASCRIPT_BUDGET_BYTES = 290_000;

const budgets = [
  { pattern: /^index-.*\.js$/, label: 'app shell', bytes: 90_000 },
  { pattern: /^index-.*\.css$/, label: 'app styles', bytes: 45_000 },
  { pattern: /^vendor-react-.*\.js$/, label: 'React runtime', bytes: 220_000 },
  { pattern: /^vendor-r3f-.*\.js$/, label: 'React Three Fiber runtime', bytes: 190_000 },
  { pattern: /^vendor-three-addons-.*\.js$/, label: 'lazy Three.js scene runtime', bytes: 850_000 },
  { pattern: /^anchor\.worker-.*\.js$/, label: 'anchor worker', bytes: 315_000, assetCount: 2 },
  { pattern: /^xfeat\.worker-.*\.js$/, label: 'XFeat worker', bytes: 24_000 },
  {
    pattern: /^interactiveSegmenter\.worker-.*\.js$/,
    label: 'selection worker',
    bytes: 170_000,
    assetCount: 2,
  },
  { pattern: /^depth\.worker-.*\.js$/, label: 'depth worker', bytes: 150_000 },
  {
    pattern: /^PersonalityService-.*\.js$/,
    label: 'lazy personality runtime',
    bytes: 22_000,
  },
  {
    pattern: /^FieldControlsDrawer-.*\.js$/,
    label: 'lazy field controls drawer',
    bytes: 40_000,
  },
  { pattern: /^viteEnv-.*\.js$/, label: 'shared deferred environment config', bytes: 1_000 },
  { pattern: /^localAIClient-.*\.js$/, label: 'shared deferred local AI transport', bytes: 10_000 },
];

const deferredAssetPatterns = [
  /^anchor\.worker-.*\.js$/,
  /^interactiveSegmenter\.worker-.*\.js$/,
  /^xfeat\.worker-.*\.js$/,
  /^depth\.worker-.*\.js$/,
  /^anchor\.depthFusion-.*\.js$/,
  /^PersonalityService-.*\.js$/,
  /^FieldControlsDrawer-.*\.js$/,
  /^viteEnv-.*\.js$/,
  /^localAIClient-.*\.js$/,
  /^ttsClient-.*\.js$/,
  /^OverlayScene-.*\.js$/,
  /^vendor-r3f-.*\.js$/,
  /^vendor-three-addons-.*\.js$/,
];

const readAttribute = (tag, attribute) => {
  const marker = `${attribute}="`;
  const start = tag.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const valueStart = start + marker.length;
  const valueEnd = tag.indexOf('"', valueStart);
  if (valueEnd === -1) {
    throw new Error(`Malformed ${attribute} attribute in production index`);
  }
  return tag.slice(valueStart, valueEnd);
};

const readStartupJavaScriptFiles = (indexHtml) => {
  const files = new Set();
  for (const fragment of indexHtml.split('<').slice(1)) {
    const tagEnd = fragment.indexOf('>');
    if (tagEnd === -1) {
      throw new Error('Malformed production index tag');
    }
    const tag = fragment.slice(0, tagEnd);
    const isScript = tag.startsWith('script ');
    const isModulePreload = tag.startsWith('link ') && readAttribute(tag, 'rel') === 'modulepreload';
    if (!isScript && !isModulePreload) {
      continue;
    }

    const assetPath = readAttribute(tag, isScript ? 'src' : 'href');
    if (!assetPath) {
      if (isModulePreload) {
        throw new Error('Production modulepreload is missing href');
      }
      continue;
    }
    if (!assetPath.startsWith('/assets/')) {
      throw new Error(`Startup JavaScript must be emitted under /assets/: ${assetPath}`);
    }
    if (!assetPath.endsWith('.js') && !assetPath.endsWith('.mjs')) {
      throw new Error(`Startup JavaScript asset has an unsupported extension: ${assetPath}`);
    }
    files.add(assetPath.slice('/assets/'.length));
  }

  if (files.size === 0) {
    throw new Error('Production index has no startup JavaScript assets');
  }
  return [...files];
};

const main = async () => {
  const files = await readdir(DIST_ASSETS);
  for (const budget of budgets) {
    const matches = files.filter((file) => budget.pattern.test(file));
    const expectedAssetCount = budget.assetCount ?? 1;
    if (matches.length !== expectedAssetCount) {
      throw new Error(`Expected ${expectedAssetCount} ${budget.label} build assets, found ${matches.length}`);
    }
    const sizes = await Promise.all(
      matches.map((file) => stat(join(DIST_ASSETS, file)).then((entry) => entry.size)),
    );
    const size = Math.max(...sizes);
    if (size > budget.bytes) {
      throw new Error(
        budget.label + ' exceeds its raw size budget: ' + size + ' > ' + budget.bytes + ' bytes',
      );
    }
  }

  const indexHtml = await readFile(DIST_INDEX, 'utf8');
  const startupJavaScriptFiles = readStartupJavaScriptFiles(indexHtml);
  const startupJavaScriptSizes = await Promise.all(
    startupJavaScriptFiles.map((file) => stat(join(DIST_ASSETS, file)).then((entry) => entry.size)),
  );
  const startupJavaScriptBytes = startupJavaScriptSizes.reduce((total, bytes) => total + bytes, 0);
  if (startupJavaScriptBytes > STARTUP_JAVASCRIPT_BUDGET_BYTES) {
    throw new Error(
      `Startup JavaScript exceeds its raw size budget: ${startupJavaScriptBytes} > ${STARTUP_JAVASCRIPT_BUDGET_BYTES} bytes`,
    );
  }

  const deferredAssets = files.filter((file) => deferredAssetPatterns.some((pattern) => pattern.test(file)));
  for (const file of deferredAssets) {
    if (indexHtml.includes(`/assets/${file}`)) {
      throw new Error(`Deferred production asset is preloaded at startup: ${file}`);
    }
  }

  console.log(
    `Verified ${budgets.length} production bundle budgets, ${startupJavaScriptBytes} startup JavaScript bytes, and ${deferredAssets.length} deferred assets`,
  );
};

main();
