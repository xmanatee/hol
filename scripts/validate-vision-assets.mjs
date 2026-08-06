import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCapabilityPacks } from '../src/runtime/capabilityPacks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const DIST_ASSETS = join(DIST, 'assets');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const requireMatch = async (files, pattern, label, minimumBytes) => {
  const matches = files.filter((file) => pattern.test(file));
  const candidates = [];
  for (const file of matches) {
    const size = (await stat(join(DIST_ASSETS, file))).size;
    if (size >= minimumBytes) {
      candidates.push(file);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(label + ' must have exactly one complete hashed build asset; found ' + candidates.length);
  }
  return join(DIST_ASSETS, candidates[0]);
};

const verifyCapabilityAsset = async (files, asset) => {
  const sourceName = new URL(asset.url).pathname.split('/').pop();
  const extensionIndex = sourceName.lastIndexOf('.');
  const baseName = sourceName.slice(0, extensionIndex);
  const extension = sourceName.slice(extensionIndex + 1);
  const pattern = new RegExp('^' + baseName + '-[A-Za-z0-9_-]+\\.' + extension + '$');
  const path = await requireMatch(files, pattern, asset.id, asset.bytes);
  const contents = await readFile(path);
  if (contents.length !== asset.bytes || sha256(contents) !== asset.sha256) {
    throw new Error(asset.id + ' build output does not match its capability manifest');
  }
};

const scanForForbiddenOutput = async (files) => {
  const forbiddenNames =
    /(yolo|untitled|depth_anything_v2_small|ptm_512_hdt|tapvid|\.tracks(?:-[A-Za-z0-9_-]+)?\.json$|\.rgb(?:-[A-Za-z0-9_-]+)?\.gz$)/i;
  const staleFiles = files.filter((file) => forbiddenNames.test(file));
  if (staleFiles.length) {
    throw new Error('Legacy build assets detected: ' + staleFiles.join(', '));
  }

  const scriptFiles = files.filter((file) => /\.(?:js|mjs)$/.test(file));
  const forbiddenSecrets = /sk-(?:proj|live|test)-[A-Za-z0-9_-]{12,}/;
  for (const file of scriptFiles) {
    const source = await readFile(join(DIST_ASSETS, file), 'utf8');
    if (forbiddenSecrets.test(source)) {
      throw new Error('Secret-like API key material found in ' + file);
    }
  }
};

const main = async () => {
  const files = await readdir(DIST_ASSETS);
  await stat(join(DIST, 'index.html'));
  await stat(join(DIST, 'sw.js'));

  await requireMatch(
    files,
    /^interactiveSegmenter\.worker-[A-Za-z0-9_-]+\.js$/,
    'interactive segmenter worker',
    100_000,
  );
  await requireMatch(files, /^anchor\.worker-[A-Za-z0-9_-]+\.js$/, 'anchor worker', 200_000);
  await requireMatch(
    files,
    /^vision_wasm_module_internal-[A-Za-z0-9_-]+\.wasm$/,
    'MediaPipe WASM runtime',
    1_000_000,
  );
  const ortWasm = files.filter((file) => /^ort-wasm-.*\.wasm$/.test(file));
  if (ortWasm.length === 0) {
    throw new Error('ONNX Runtime WASM fallback is missing');
  }

  for (const asset of listCapabilityPacks().flatMap((pack) => pack.assets)) {
    await verifyCapabilityAsset(files, asset);
  }
  await scanForForbiddenOutput(files);
  console.log('Validated ' + files.length + ' hashed production assets and all capability manifests');
};

main();
