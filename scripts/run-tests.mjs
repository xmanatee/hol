import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_SUITE_GLOBS = Object.freeze({
  all: 'src/**/*.test.js',
  vision: 'src/cv/**/*.test.js',
});

const BOOLEAN_RUNNER_OPTIONS = new Set([
  '--experimental-test-coverage',
  '--test-force-exit',
  '--test-only',
  '--test-update-snapshots',
  '--watch',
]);
const VALUE_RUNNER_OPTIONS = new Set([
  '--test-concurrency',
  '--test-coverage-branches',
  '--test-coverage-exclude',
  '--test-coverage-functions',
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-isolation',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
]);

const readSuite = (arguments_) => {
  const suiteArguments = arguments_.filter((argument) => argument.startsWith('--suite='));
  if (suiteArguments.length !== 1) {
    throw new TypeError('Test runner requires exactly one --suite=<all|vision> argument');
  }

  const suite = suiteArguments[0].slice('--suite='.length);
  if (!Object.hasOwn(TEST_SUITE_GLOBS, suite)) {
    throw new RangeError(`Unsupported test suite: ${suite}`);
  }
  return { suite, suiteArgument: suiteArguments[0] };
};

const appendRunnerOption = (runnerArguments, argument, followingArgument) => {
  const equalsIndex = argument.indexOf('=');
  const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);

  if (BOOLEAN_RUNNER_OPTIONS.has(option)) {
    if (equalsIndex !== -1) {
      throw new TypeError(`${option} does not accept a value`);
    }
    runnerArguments.push(option);
    return 0;
  }
  if (!VALUE_RUNNER_OPTIONS.has(option)) {
    throw new RangeError(`Unsupported test runner option: ${option}`);
  }
  if (equalsIndex !== -1) {
    if (equalsIndex === argument.length - 1) {
      throw new TypeError(`${option} requires a value`);
    }
    runnerArguments.push(argument);
    return 0;
  }
  if (followingArgument === undefined || followingArgument.startsWith('--')) {
    throw new TypeError(`${option} requires a value`);
  }
  runnerArguments.push(option, followingArgument);
  return 1;
};

export const createTestArguments = (arguments_) => {
  if (!Array.isArray(arguments_)) {
    throw new TypeError('Test runner arguments must be an array');
  }

  const { suite, suiteArgument } = readSuite(arguments_);
  const runnerArguments = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === suiteArgument) {
      continue;
    }
    if (!argument.startsWith('--')) {
      throw new TypeError(`Unexpected positional test runner argument: ${argument}`);
    }
    index += appendRunnerOption(runnerArguments, argument, arguments_[index + 1]);
  }

  return ['--test', ...runnerArguments, TEST_SUITE_GLOBS[suite]];
};

const runTestSuite = (arguments_) => {
  const child = spawn(process.execPath, createTestArguments(arguments_), {
    stdio: 'inherit',
  });
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (exitCode, signal) => {
      if (signal) {
        rejectExit(new Error(`Test runner terminated by ${signal}`));
        return;
      }
      resolveExit(exitCode);
    });
  });
};

const modulePath = fileURLToPath(import.meta.url);
if (resolve(process.argv[1]) === modulePath) {
  process.exitCode = await runTestSuite(process.argv.slice(2));
}
