import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const nginxConfig = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');

function readContentSecurityPolicy(config) {
  const match = config.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/);
  assert.ok(match, 'nginx.conf must define Content-Security-Policy');
  return match[1];
}

function readDirective(policy, name) {
  const directive = policy
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name} `));

  assert.ok(directive, `Content-Security-Policy must define ${name}`);
  return directive.split(/\s+/).slice(1);
}

test('production CSP permits OpenCV embedded WASM loading', () => {
  const policy = readContentSecurityPolicy(nginxConfig);
  const connectSrc = readDirective(policy, 'connect-src');

  assert.ok(
    connectSrc.includes('data:'),
    'OpenCV loads its embedded WASM through fetch(data:...), so connect-src must allow data:'
  );
});
