import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestArguments, discoverTestFiles, selectTestFiles } from '../../scripts/run-tests.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

const readProjectFile = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

test('fast and integration portfolios partition every discovered source test exactly once', async () => {
  const entries = await readdir(sourceRoot, { recursive: true });
  const expected = entries
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `src/${name}`)
    .sort();
  const files = discoverTestFiles();
  assert.deepEqual(files, expected);
  const unit = selectTestFiles(files, 'unit');
  const integration = selectTestFiles(files, 'integration');
  assert.ok(unit.length > 0);
  assert.ok(integration.length > 0);
  assert.deepEqual([...unit, ...integration].sort(), expected);
  assert.equal(
    unit.some((name) => integration.includes(name)),
    false,
  );
  assert.ok(integration.some((name) => name.includes('syntheticVisionReplay')));
});

test('test selection distinguishes integration boundaries and preserves Node runner options', () => {
  const files = ['src/api/client.test.js', 'src/cv/replay.integration.test.js', 'src/cv/matrix.unit.test.js'];
  assert.deepEqual(selectTestFiles(files, 'unit'), ['src/api/client.test.js', 'src/cv/matrix.unit.test.js']);
  assert.deepEqual(selectTestFiles(files, 'integration'), ['src/cv/replay.integration.test.js']);
  assert.deepEqual(selectTestFiles(files, 'vision'), [
    'src/cv/matrix.unit.test.js',
    'src/cv/replay.integration.test.js',
  ]);
  assert.deepEqual(createTestArguments(['--suite=all'], files), ['--test', ...files.toSorted()]);
  assert.deepEqual(
    createTestArguments(
      ['--suite=integration', '--test-name-pattern=benchmark CLI', '--test-concurrency', '2'],
      files,
    ),
    [
      '--test',
      '--test-name-pattern=benchmark CLI',
      '--test-concurrency',
      '2',
      'src/cv/replay.integration.test.js',
    ],
  );
  assert.throws(() => createTestArguments([]), /requires exactly one --suite/);
  assert.throws(() => createTestArguments(null), /must be an array/);
  assert.throws(() => createTestArguments(['--suite=all', '--suite=vision']), /requires exactly one --suite/);
  assert.throws(() => createTestArguments(['--suite=unknown']), /Unsupported test suite/);
  assert.throws(() => createTestArguments(['--suite=all', '--test-name-pattern']), /requires a value/);
  assert.throws(() => createTestArguments(['--suite=all', '--test-name-pattern=']), /requires a value/);
  assert.throws(() => createTestArguments(['--suite=all', '--watch=true']), /does not accept a value/);
  assert.throws(() => createTestArguments(['--suite=all', '--inspect']), /Unsupported test runner option/);
  assert.throws(
    () => createTestArguments(['--suite=all', 'src/api/localAIClients.test.js']),
    /Unexpected positional/,
  );
  assert.throws(() => createTestArguments(['--suite=integration'], ['src/only.test.js']), /No tests found/);
});

test('package installation fails on unsupported runtimes and keeps dependency versions exact', async () => {
  const packageJson = JSON.parse(await readProjectFile('package.json'));
  assert.deepEqual(packageJson.engines, {
    node: '>=22.13.0 <23',
    npm: '>=10.9.0 <12',
  });

  const npmConfig = await readProjectFile('.npmrc');
  assert.equal(npmConfig, 'engine-strict=true\nsave-exact=true\nstrict-peer-deps=true\n');

  assert.equal(await readProjectFile('.nvmrc'), '22\n');
  const workflow = await readProjectFile('.github/workflows/ci.yml');
  assert.match(workflow, /node-version-file: ['"]?\.nvmrc['"]?/);
  assert.doesNotMatch(workflow, /^\s+node-version:/m);
});

test('mobile browser tests bound fake-camera concurrency in every environment', async () => {
  const playwrightConfig = await readProjectFile('playwright.config.js');

  assert.match(playwrightConfig, /^\s+workers: 2,$/m);
  assert.doesNotMatch(playwrightConfig, /workers:\s*process\.env\.CI/);
});
