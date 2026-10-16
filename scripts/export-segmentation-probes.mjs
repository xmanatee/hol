import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSegmentationProbe,
  SEGMENTATION_EXPERIMENT_CASES,
  SEGMENTATION_EXPERIMENT_POLICY,
  SEGMENTATION_EXPERIMENT_PROTOCOL,
} from '../src/cv/synthetic/segmentationExperiment.js';

export const exportSegmentationProbes = async (outputPath) => {
  await mkdir(outputPath, { recursive: true });
  const cases = [];
  for (const { id } of SEGMENTATION_EXPERIMENT_CASES) {
    const { imageData, truth, point } = createSegmentationProbe(id);
    const files = {};
    for (const [role, suffix, data] of [
      ['input', 'rgba', imageData.data],
      ['truth', 'mask', truth],
    ]) {
      const file = `${id}.${suffix}`;
      await writeFile(join(outputPath, file), data);
      files[role] = {
        file,
        bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
    }
    cases.push({ id, width: imageData.width, height: imageData.height, point, ...files });
  }
  const manifest = {
    protocol: SEGMENTATION_EXPERIMENT_PROTOCOL,
    policy: SEGMENTATION_EXPERIMENT_POLICY,
    inputEncoding: 'uint8 RGBA; interleaved; row-major; top-left origin; opaque alpha',
    truthEncoding: 'uint8; row-major; 0=background; 255=target',
    pointCoordinates: 'source-raster pixels; x right; y down',
    scope: 'Static analytic point-prompt masks, not video tracking or real-world objectness evidence',
    cases,
  };
  await writeFile(join(outputPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !args[0].startsWith('--output=')))
    throw new TypeError('Expected zero arguments or --output=<directory>');
  if (args.length === 1 && args[0] === '--output=') throw new TypeError('Output directory cannot be empty');
  const outputPath = resolve(
    args.length === 1 ? args[0].slice('--output='.length) : 'artifacts/segmentation-probes',
  );
  const manifest = await exportSegmentationProbes(outputPath);
  console.log(`Exported ${manifest.cases.length} pinned ${manifest.protocol} probes to ${outputPath}`);
}
