// -----------------------------------------------------------------------------
// scripts/probe.mjs against the fake recorder served on 127.0.0.1: it reads,
// lists, listens, writes nothing, and prints no secret.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { FakeDahua, PASSWORD } from './helpers/fakeDahua.js';

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/probe.mjs', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env, LOG_LEVEL: 'silent' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('the probe reads a recorder and its events, writes nothing, prints no secret', async (t) => {
  const fake = new FakeDahua({ name: 'recorder' });
  const server = await fake.serve();
  t.after(() => server.close());
  const emitting = setInterval(() => fake.emit('smartHumanStart'), 300);
  t.after(() => clearInterval(emitting));
  const { code, output } = await run([server.origin, 'admin', '1'], { DAHUA_PASSWORD: PASSWORD });
  assert.equal(code, 0, output);
  assert.match(output, /Kind\s+recorder/);
  assert.match(output, /Channel 1\s+FRONT STREET/);
  assert.match(output, /Serial\s+…F123/);
  assert.match(output, /SmartMotionHuman Start index=1/);
  for (const secret of [PASSWORD, 'CameraSecret0', '7D0CE45AB98F123']) {
    assert.ok(!output.includes(secret), secret);
  }
  assert.ok(!fake.requests.some((request) => request.path.includes('setConfig')));
});

test('the probe stops at a refused password, and says how to use it', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  const server = await fake.serve();
  const refused = await run([server.origin], { DAHUA_PASSWORD: 'wrong' });
  await server.close();
  assert.equal(refused.code, 1);
  assert.match(refused.output, /password refused/);
  assert.equal(fake.refusals, 1);
  const usage = await run([], { DAHUA_PASSWORD: '' });
  assert.equal(usage.code, 2);
});
