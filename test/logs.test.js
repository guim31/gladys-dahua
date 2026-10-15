// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal cycle — reads, events, persons, rings, images, scene events
// — writes nothing; a failure that repeats is logged once, and its end once.
// Never a password of the configuration, nor one a recorder holds for its
// cameras.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_CONFIG,
  DOORBELL_PASSWORD,
  PASSWORD,
  createAll,
  createWorld,
  doorbellIds,
  settle,
} from './helpers/world.js';

/** Capture the lines of the SDK logger at a level. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRETS = [PASSWORD, DOORBELL_PASSWORD, 'CameraSecret0', 'CameraSecret1', 'CameraSecret2'];

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('a normal cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  assert.ok(
    logs.texts().some((text) => text.includes('Connected to DHI-NVR5464-16P-EI at 192.0.2.20')),
    'the start is logged',
  );
  await createAll(w);
  logs.clear();

  for (let i = 0; i < 3; i += 1) {
    await w.emit('camera', 'motionStart');
    await w.emit('camera', 'crossLineHuman');
    await w.emit('camera', 'motionStop');
    await w.emit('recorder', 'smartHumanStart');
    await w.emit('recorder', 'smartHumanStop');
    await w.emit('doorbell', 'ring');
    w.devices.camera.heartbeat();
    w.clock.advance(5 * 60_000);
    await w.hub.refresh();
    await w.hub.snapshotAll();
    await w.fake.widgetGet('dahua', { settings: {}, language: 'en' });
  }
  await sleep(80); // the pulses end
  await settle();
  assert.deepEqual(logs.texts(), []);
  assert.ok(w.fake.sceneEvents.length >= 6);
});

test('the hourly recycling of the event streams writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { streamTimings: { recycleMs: 20 } });
  await createAll(w);
  logs.clear();
  await sleep(120);
  await settle();
  assert.ok(w.devices.camera.streamAttempts >= 3, 'recycled several times');
  assert.deepEqual(logs.texts(), []);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('a device that stays down is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();

  w.devices.camera.online = false;
  w.devices.camera.dropStreams();
  for (let i = 0; i < 6; i += 1) {
    w.clock.advance(60_000);
    await w.hub.refresh();
    await sleep(30); // the stream retries
  }
  const lines = logs.texts();
  assert.equal(
    lines.filter((text) => text.includes('Cannot read the device at 192.0.2.10')).length,
    1,
    lines.join('\n'),
  );
  assert.equal(
    lines.filter((text) => text.includes('Live events of 192.0.2.10')).length,
    1,
    lines.join('\n'),
  );
  assert.equal(
    lines.filter((text) => text.includes('192.0.2.10 is offline')).length,
    1,
    lines.join('\n'),
  );
  assert.equal(lines.length, 3, lines.join('\n'));

  logs.clear();
  w.devices.camera.online = true;
  await w.hub.refresh();
  await sleep(80);
  await settle();
  await w.hub.refresh();
  const back = logs.texts();
  assert.equal(
    back.filter((text) => /answers again after 5 min/.test(text)).length,
    1,
    back.join('\n'),
  );
  assert.equal(back.filter((text) => text.includes('connected again')).length, 1, back.join('\n'));
  assert.equal(back.filter((text) => text.includes('online again')).length, 1, back.join('\n'));
  assert.equal(back.length, 3, back.join('\n'));
});

test('a refused password is logged once, its repeats only at debug; never a password', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: { ...BASE_CONFIG, password_2: 'wrong-door-secret-value' } });
  for (let i = 0; i < 5; i += 1) {
    await w.hub.refresh();
    await sleep(30);
  }
  const warnings = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(warnings.length, 1, logs.texts().join('\n'));
  assert.match(
    warnings[0].text,
    /Cannot read the device at 192\.0\.2\.30: User name or password refused/,
  );
  const all = logs.texts().join('\n');
  for (const secret of [...SECRETS, 'wrong-door-secret-value']) {
    assert.ok(!all.includes(secret), secret);
  }
});

test('a camera that stops sending images is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  await createAll(w);
  logs.clear();
  w.devices.recorder.snapshotStatus = 500;
  for (let i = 0; i < 4; i += 1) {
    w.clock.advance(10 * 60_000);
    await w.hub.snapshotAll();
  }
  const failing = logs.texts();
  // One line per channel of the recorder.
  assert.equal(failing.length, 2, failing.join('\n'));
  assert.ok(failing.every((text) => text.includes('No image from')));
  logs.clear();
  w.devices.recorder.snapshotStatus = 200;
  w.clock.advance(10 * 60_000);
  await w.hub.snapshotAll();
  assert.equal(logs.texts().length, 2, logs.texts().join('\n'));
  assert.ok(logs.texts().every((text) => text.includes('back')));
});

test('a user command is one line; the stream address never holds the password', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: { ...BASE_CONFIG, allow_door_open: true } });
  await createAll(w);
  logs.clear();
  const camera = w.fake.discoveredDevices[0];
  const floodlight = camera.features.find((f) => f.external_id.endsWith(':floodlight'));
  await w.fake.setValue(camera, floodlight, 1);
  assert.deepEqual(logs.texts().length, 1);
  assert.match(logs.texts()[0], /Entree: floodlight on/);
  logs.clear();
  await w.fake.action('stream_url', { camera: camera.external_id });
  assert.equal(logs.texts().length, 1);
  logs.clear();
  await w.fake.sceneAction('open_door', { doorbell: doorbellIds(w.gladys).device, door: '1' });
  assert.equal(logs.texts().length, 1);
  assert.match(logs.texts()[0], /door 1 of Portier opened/);
});

test('LOG_LEVEL=debug shows the events and the reads; never a password', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t);
  await w.emit('camera', 'crossLineHuman');
  w.devices.camera.online = false;
  await w.hub.refresh();
  await w.hub.refresh();
  const text = logs.texts().join('\n');
  assert.match(text, /\[DEBUG\].*Event CrossLineDetection \(Start\) on Entree/);
  assert.match(text, /\[DEBUG\].*Cannot read the device at 192\.0\.2\.10/);
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), secret);
  }
});
