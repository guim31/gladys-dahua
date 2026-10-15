// -----------------------------------------------------------------------------
// The event stream of a device: events handed over part by part, a dropped
// stream opened again, a refused password stopping it (no retry loop on a
// password), a refused stream retried with a growing wait.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DahuaClient } from '../src/dahua/client.js';
import { EventStream } from '../src/dahua/events.js';
import { FakeDahua, PASSWORD, USERNAME } from './helpers/fakeDahua.js';
import { settle } from './helpers/world.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function open(fake, { password = PASSWORD, timings = {} } = {}) {
  const client = new DahuaClient({
    origin: 'http://192.0.2.10',
    username: USERNAME,
    password,
    request: fake.request,
  });
  const seen = { events: [], opened: 0, closed: [] };
  const stream = new EventStream({
    client,
    onEvent: (event) => seen.events.push(event),
    onOpen: () => {
      seen.opened += 1;
    },
    onClose: (err) => seen.closed.push(err),
    timings: { quickRetryMs: 10, failureBaseMs: 10, failureMaxMs: 40, ...timings },
    random: () => 0.5,
  });
  stream.start();
  return { stream, client, seen };
}

test('events are handed over as they come; heartbeats are not events', async (t) => {
  const fake = new FakeDahua({ name: 'camera' });
  const { stream, seen } = open(fake);
  t.after(() => stream.stop());
  await settle();
  assert.equal(seen.opened, 1);
  fake.heartbeat();
  fake.emit('motionStart');
  fake.emit('crossLineHuman');
  await settle();
  assert.deepEqual(
    seen.events.map((event) => [event.code, event.action]),
    [
      ['VideoMotion', 'Start'],
      ['CrossLineDetection', 'Start'],
    ],
  );
  assert.ok(fake.requests.some((r) => r.path.includes('codes=[All]&heartbeat=5')));
});

test('a dropped stream is opened again, quickly when it carried data', async (t) => {
  const fake = new FakeDahua({ name: 'camera' });
  const { stream, seen } = open(fake);
  t.after(() => stream.stop());
  await settle();
  fake.heartbeat();
  await settle();
  fake.dropStreams();
  await sleep(40);
  await settle();
  assert.equal(seen.closed.length, 1);
  assert.equal(seen.opened, 2);
  fake.emit('motionStop');
  await settle();
  assert.equal(seen.events.at(-1).action, 'Stop');
});

test('a refused password stops the stream instead of retrying', async (t) => {
  const fake = new FakeDahua({ name: 'camera' });
  const { stream, seen } = open(fake, { password: 'wrong' });
  t.after(() => stream.stop());
  await sleep(100);
  assert.equal(seen.opened, 0);
  assert.equal(seen.closed.length, 1);
  assert.equal(seen.closed[0].kind, 'auth');
  assert.equal(fake.streamAttempts, 0);
  assert.equal(fake.refusals, 1);
});

test('a stream refused by the device is retried with a growing wait', async (t) => {
  const fake = new FakeDahua({ name: 'camera' });
  fake.streamStatus = 500;
  const { stream, seen } = open(fake, { timings: { failureBaseMs: 20, failureMaxMs: 1000 } });
  t.after(() => stream.stop());
  await sleep(100);
  // 0, 20, 40 (then 80): three or four attempts, not one per tick.
  assert.ok(fake.streamAttempts >= 3 && fake.streamAttempts <= 4, `${fake.streamAttempts}`);
  assert.ok(seen.closed.every((err) => err.kind === 'http'));
  fake.streamStatus = 200;
});

test('stop closes the stream and no attempt follows', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  const { stream } = open(fake);
  await settle();
  stream.stop();
  await settle();
  assert.equal(fake.streams.size, 0);
  const attempts = fake.streamAttempts;
  await sleep(50);
  assert.equal(fake.streamAttempts, attempts);
});
