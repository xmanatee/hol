import assert from 'node:assert/strict';
import { glob, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestArguments, TEST_SUITE_GLOBS } from '../../scripts/run-tests.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

const readProjectFile = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

test('the canonical source-test glob discovers every source test exactly once', async () => {
  const packageJson = JSON.parse(await readProjectFile('package.json'));
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs --suite=all');
  assert.equal(packageJson.scripts['test:vision'], 'node scripts/run-tests.mjs --suite=vision');
  assert.equal(Object.hasOwn(packageJson.scripts, 'test:unit'), false);

  const sourceEntries = await readdir(sourceRoot, { recursive: true });
  const expectedTests = sourceEntries
    .filter((relativePath) => relativePath.endsWith('.test.js'))
    .map((relativePath) => `src/${relativePath}`)
    .sort();
  const discoveredTests = (await Array.fromAsync(glob(TEST_SUITE_GLOBS.all, { cwd: projectRoot }))).sort();

  assert.ok(expectedTests.length > 0);
  assert.deepEqual(discoveredTests, expectedTests);
  assert.equal(new Set(discoveredTests).size, discoveredTests.length);
});

test('test runner validates suites and places supported Node options before the test glob', () => {
  assert.deepEqual(createTestArguments(['--suite=all']), ['--test', TEST_SUITE_GLOBS.all]);
  assert.deepEqual(
    createTestArguments(['--suite=vision', '--test-name-pattern=benchmark CLI', '--test-concurrency', '2']),
    ['--test', '--test-name-pattern=benchmark CLI', '--test-concurrency', '2', TEST_SUITE_GLOBS.vision],
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
    /Unexpected positional test runner argument/,
  );
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
  assert.match(workflow, /node-version-file: '\.nvmrc'/);
  assert.doesNotMatch(workflow, /^\s+node-version:/m);
});

test('mobile browser tests bound fake-camera concurrency in every environment', async () => {
  const playwrightConfig = await readProjectFile('playwright.config.js');

  assert.match(playwrightConfig, /^\s+workers: 2,$/m);
  assert.doesNotMatch(playwrightConfig, /workers:\s*process\.env\.CI/);
});

test('release verification owns every deterministic synthetic vision contract', async () => {
  const packageJson = JSON.parse(await readProjectFile('package.json'));
  const workflow = await readProjectFile('.github/workflows/ci.yml');
  const expectedVisionGate =
    'npm run vision:quality && npm run vision:benchmark:quick && npm run vision:benchmark:hard && npm run test:vision:annotated';

  assert.equal(packageJson.scripts['verify:vision'], expectedVisionGate);
  assert.equal(
    packageJson.scripts['verify:release'],
    'npm run validate && npm run verify:vision && npm run sbom && npm run verify:licenses && npm audit --audit-level=high',
  );
  assert.equal(Object.hasOwn(packageJson.scripts, 'fetch:vision-fixtures'), false);
  assert.match(
    workflow,
    /- name: Verify release and deterministic vision contracts\n\s+run: npm run verify:release/,
  );
});
