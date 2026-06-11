import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_FIXTURE_DIR = join(process.env.HOME || process.cwd(), '.cache', 'hol-real-vision');
const fixtureDir = process.env.HOL_REAL_VISION_FIXTURES || DEFAULT_FIXTURE_DIR;
const manifestPath = join(fixtureDir, 'manifest.json');

const exists = async path => access(path).then(() => true, () => false);

const validateEntry = async entry => {
  const filePath = join(fixtureDir, entry.path);
  const fileStat = await stat(filePath);
  if (fileStat.size < entry.minimumBytes) {
    throw new Error(`${entry.dataset}/${entry.path} is too small: ${fileStat.size} bytes`);
  }
};

if (!await exists(manifestPath)) {
  console.log(`Real vision fixtures not installed; skipping. Expected manifest at ${manifestPath}`);
  process.exit(0);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest.fixtures)) {
  throw new Error('Real vision fixture manifest must contain a fixtures array');
}

for (const entry of manifest.fixtures) {
  await validateEntry(entry);
}

console.log(`Validated ${manifest.fixtures.length} real vision fixture files from ${fixtureDir}`);
