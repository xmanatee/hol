import assert from 'node:assert/strict';
import test from 'node:test';
import { readViteEnv } from './viteEnv.js';

test('reads only the explicit local-runtime environment contract', () => {
  assert.equal(readViteEnv('VITE_LOCAL_AI_BASE_URL'), undefined);
  assert.equal(readViteEnv('VITE_LOCAL_AI_MODEL'), undefined);
  assert.throws(() => readViteEnv('VITE_UNKNOWN'), /Unsupported Vite environment key: VITE_UNKNOWN/);
});
