import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeVisionFixtureManifest,
  validateVisionFixtureManifest,
} from './visionFixtureManifest.js';

test('vision fixture manifest validates datasets tasks and annotation paths', () => {
  const result = validateVisionFixtureManifest({
    fixtures: [
      {
        dataset: 'DAVIS',
        path: 'davis/bear/frame-0001.png',
        minimumBytes: 1024,
        tasks: ['segmentation'],
        annotations: {
          mask: 'davis/bear/mask-0001.png',
        },
      },
      {
        dataset: 'TAPVid-3D',
        path: 'tapvid3d/sample/video.mp4',
        minimumBytes: 2048,
        tasks: ['pointTracking', 'pose3d'],
        annotations: {
          tracks: 'tapvid3d/sample/tracks.json',
          camera: 'tapvid3d/sample/camera.json',
        },
      },
    ],
  });

  assert.equal(result.fixtures.length, 2);
  assert.deepEqual(result.fixtures[0].tasks, ['segmentation']);
  assert.deepEqual(result.fixtures[1].annotationPaths, [
    'tapvid3d/sample/tracks.json',
    'tapvid3d/sample/camera.json',
  ]);
});

test('vision fixture manifest rejects unsafe paths and unknown tasks', () => {
  assert.throws(
    () => validateVisionFixtureManifest({
      fixtures: [{
        dataset: 'DAVIS',
        path: '../secret.txt',
        minimumBytes: 1,
      }],
    }),
    /path must be a safe relative path/
  );

  assert.throws(
    () => validateVisionFixtureManifest({
      fixtures: [{
        dataset: 'CO3D',
        path: 'co3d/apple/frame.png',
        minimumBytes: 1,
        tasks: ['meshHallucination'],
      }],
    }),
    /Unknown real vision task/
  );
});

test('source fixture manifests require downloadable URLs', () => {
  assert.throws(
    () => validateVisionFixtureManifest({
      fixtures: [{
        dataset: 'DAVIS',
        path: 'davis/bear/frame.png',
        minimumBytes: 1,
        tasks: ['segmentation'],
      }],
    }, { requireUrls: true }),
    /url is required/
  );

  const result = validateVisionFixtureManifest({
    fixtures: [{
      dataset: 'DAVIS',
      path: 'davis/bear/frame.png',
      url: 'https://example.test/davis/bear/frame.png',
      minimumBytes: 1,
      tasks: ['segmentation'],
    }],
  }, { requireUrls: true });

  assert.equal(result.fixtures[0].url, 'https://example.test/davis/bear/frame.png');
});

test('vision fixture manifest summary reports dataset task and annotation coverage', () => {
  const validated = validateVisionFixtureManifest({
    fixtures: [
      {
        dataset: 'DAVIS',
        path: 'davis/bear/frame-0001.png',
        minimumBytes: 1024,
        tasks: ['segmentation'],
        annotations: { mask: 'davis/bear/mask-0001.png' },
      },
      {
        dataset: 'TAPVid-3D',
        path: 'tapvid3d/sample/video.mp4',
        minimumBytes: 2048,
        tasks: ['pointTracking', 'pose3d'],
        annotations: {
          tracks: 'tapvid3d/sample/tracks.json',
          camera: 'tapvid3d/sample/camera.json',
        },
      },
    ],
  });

  const summary = summarizeVisionFixtureManifest(validated);

  assert.equal(summary.total, 2);
  assert.equal(summary.byDataset.DAVIS, 1);
  assert.equal(summary.byTask.segmentation, 1);
  assert.equal(summary.byTask.pointTracking, 1);
  assert.equal(summary.annotationFiles, 3);
});
