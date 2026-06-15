import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { validateVisionFixtureManifest } from '../src/cv/visionFixtureManifest.js';

const DEFAULT_FIXTURE_DIR = join(process.env.HOME || process.cwd(), '.cache', 'hol-real-vision');
const fixtureDir = process.env.HOL_REAL_VISION_FIXTURES || DEFAULT_FIXTURE_DIR;
const sourceManifestPath = process.env.HOL_REAL_VISION_SOURCE_MANIFEST;

if (!sourceManifestPath) {
  console.log('Set HOL_REAL_VISION_SOURCE_MANIFEST to a JSON manifest with licensed DAVIS/TAP-Vid/CO3D fixture URLs.');
  process.exit(0);
}

const sourceManifest = validateVisionFixtureManifest(
  JSON.parse(await readFile(sourceManifestPath, 'utf8')),
  { requireUrls: true }
);

const download = async entry => {
  const response = await fetch(entry.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${entry.url}: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (entry.sha256 && digest !== entry.sha256) {
    throw new Error(`${entry.path} sha256 mismatch: ${digest}`);
  }

  const targetPath = join(fixtureDir, entry.path);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);

  return {
    dataset: entry.dataset,
    path: entry.path,
    minimumBytes: entry.minimumBytes || bytes.length,
    sha256: digest,
    tasks: entry.tasks,
    annotations: entry.annotations,
  };
};

await mkdir(fixtureDir, { recursive: true });
const fixtures = [];
for (const entry of sourceManifest.fixtures) {
  fixtures.push(await download(entry));
}

await writeFile(
  join(fixtureDir, 'manifest.json'),
  `${JSON.stringify({ fixtures }, null, 2)}\n`,
  'utf8'
);

console.log(`Fetched ${fixtures.length} real vision fixture files into ${fixtureDir}`);
