import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSegmentationProbes } from '../../../scripts/export-segmentation-probes.mjs';
import { createSegmentationProbe, SEGMENTATION_EXPERIMENT_PROTOCOL } from './segmentationExperiment.js';

test('native experiments receive identical source bytes, labels, coordinates and hash ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hol-segmentation-probes-'));
  try {
    const exported = await exportSegmentationProbes(directory);
    const saved = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(saved, exported);
    assert.equal(saved.protocol, SEGMENTATION_EXPERIMENT_PROTOCOL);
    assert.equal(saved.cases.length, 8);
    for (const entry of saved.cases) {
      const probe = createSegmentationProbe(entry.id);
      assert.deepEqual(entry.point, probe.point);
      for (const [role, expected] of [
        ['input', probe.imageData.data],
        ['truth', probe.truth],
      ]) {
        const actual = await readFile(join(directory, entry[role].file));
        assert.deepEqual(new Uint8Array(actual), new Uint8Array(expected));
        assert.equal(actual.byteLength, entry[role].bytes);
        assert.equal(createHash('sha256').update(actual).digest('hex'), entry[role].sha256);
      }
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
