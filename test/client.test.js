// -----------------------------------------------------------------------------
// The CGI client against the fake device: digest authentication, the stop
// after refused passwords (a device locks the account after a few), the
// refusals hidden in a 200, absent tables, the doorbell JPEG trailer, the
// queue, and the real node:http transport on 127.0.0.1.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DahuaClient,
  ERROR_KINDS,
  MAX_AUTH_REFUSALS,
  query,
  stripTrailer,
} from '../src/dahua/client.js';
import { request as httpRequest } from '../src/dahua/http.js';
import { FakeDahua, PASSWORD, USERNAME, smallJpeg } from './helpers/fakeDahua.js';

const ORIGIN = 'http://192.0.2.10';

function client(fake, password = PASSWORD) {
  return new DahuaClient({ origin: ORIGIN, username: USERNAME, password, request: fake.request });
}

test('identity, read through digest authentication', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  const identity = await client(fake).identity();
  assert.deepEqual(identity, {
    serial: '8F0AB12CDE34F56',
    model: 'IPC-HFW3849T1-AS-PV',
    firmware: '2.800.0000016.0.R',
    name: 'Entree',
    deviceClass: 'IPC',
    vendor: 'Dahua',
  });
  assert.equal(fake.refusals, 0);
});

test('a wrong password: refused once, then the client stops before the device locks', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  const dahua = client(fake, 'wrong-password');
  for (let i = 0; i < 5; i += 1) {
    const err = await dahua.magicBox('getSystemInfo').catch((error) => error);
    assert.ok([ERROR_KINDS.AUTH, ERROR_KINDS.BLOCKED].includes(err.kind));
    assert.ok(!err.message.includes('wrong-password'));
  }
  // The device saw MAX_AUTH_REFUSALS wrong answers, not one per call.
  assert.equal(fake.refusals, MAX_AUTH_REFUSALS);
  assert.ok(MAX_AUTH_REFUSALS < 5, 'under the lockout of the documented firmwares');
  assert.equal(dahua.blocked, true);
  const requests = fake.requests.length;
  await dahua.magicBox('getSystemInfo').catch(() => {});
  assert.equal(fake.requests.length, requests, 'nothing sent while blocked');
  // The user fixed the password and tested the connection.
  dahua.password = PASSWORD;
  dahua.unblock();
  assert.equal((await dahua.identity()).serial, '8F0AB12CDE34F56');
});

test('a successful answer clears the count of refusals', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  const dahua = client(fake, 'wrong');
  await dahua.magicBox('getSystemInfo').catch(() => {});
  assert.equal(dahua.refusals, 1);
  dahua.password = PASSWORD;
  dahua.unblock();
  await dahua.magicBox('getSystemInfo');
  assert.equal(dahua.refusals, 0);
  assert.equal(dahua.blocked, false);
});

test('configuration: tables read without prefix, absent tables empty, writes checked', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  const dahua = client(fake);
  assert.deepEqual(await dahua.getConfig('MotionDetect'), {
    'MotionDetect[0].DetectVersion': 'V3.0',
    'MotionDetect[0].Enable': 'true',
  });
  assert.deepEqual(await dahua.getConfig('NoSuchTable'), {});
  await dahua.setConfig({ 'MotionDetect[0].Enable': 'false' });
  assert.equal(fake.tables.MotionDetect['MotionDetect[0].Enable'], 'false');
  // The path keeps its brackets, signed as sent.
  assert.ok(fake.requests.some((r) => r.path.endsWith('setConfig&MotionDetect[0].Enable=false')));
  const refused = await dahua.setConfig({ 'Nothing[0].Enable': 'true' }).catch((err) => err);
  assert.equal(refused.kind, ERROR_KINDS.REFUSED);
});

test('a forbidden answer is not a wrong password', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  const dahua = client(fake);
  const original = fake.answer.bind(fake);
  fake.answer = (target, path, stream) =>
    target.pathname.includes('magicBox')
      ? fake.text('Authority:check failure.', 403)
      : original(target, path, stream);
  const err = await dahua.magicBox('getSystemInfo').catch((error) => error);
  assert.equal(err.kind, ERROR_KINDS.FORBIDDEN);
  assert.equal(dahua.refusals, 0);
});

test('an unreachable device is not a wrong password either', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  fake.online = false;
  const err = await client(fake)
    .magicBox('getSystemInfo')
    .catch((error) => error);
  assert.equal(err.kind, ERROR_KINDS.UNREACHABLE);
  assert.match(err.message, /EHOSTUNREACH/);
});

test('snapshots: channel numbers, the dhav trailer of the doorbells cut', async () => {
  const fake = new FakeDahua({ name: 'doorbell' });
  const jpeg = smallJpeg();
  fake.snapshot = Buffer.concat([jpeg, Buffer.from('dhav'), Buffer.from([1, 2, 3, 4])]);
  const bytes = await client(fake).snapshot(1);
  assert.deepEqual(bytes, jpeg);
  assert.deepEqual(stripTrailer(jpeg), jpeg);
  const recorder = new FakeDahua({ name: 'recorder' });
  assert.equal(await client(recorder).snapshotsFromZero(), false);
});

test('at most two requests in flight per device', async () => {
  const fake = new FakeDahua({ name: 'camera' });
  let inFlight = 0;
  let most = 0;
  const slow = async (url, options) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return fake.request(url, options);
  };
  const dahua = new DahuaClient({
    origin: ORIGIN,
    username: USERNAME,
    password: PASSWORD,
    request: slow,
  });
  await Promise.all(Array.from({ length: 8 }, () => dahua.getConfig('MotionDetect')));
  assert.equal(most, 2);
});

test('query strings keep brackets and dots, encode the rest', () => {
  assert.equal(
    query({ 'Lighting_V2[0][0][1].Mode': 'Manual', channel: 1, 'info[0].Type': 2, x: 'a b&c' }),
    'Lighting_V2[0][0][1].Mode=Manual&channel=1&info[0].Type=2&x=a%20b%26c',
  );
});

test('the node:http transport, against the fake device on 127.0.0.1', async (t) => {
  const fake = new FakeDahua({ name: 'camera' });
  const server = await fake.serve();
  t.after(() => server.close());
  const dahua = new DahuaClient({
    origin: server.origin,
    username: USERNAME,
    password: PASSWORD,
    request: httpRequest,
  });
  assert.equal((await dahua.identity()).serial, '8F0AB12CDE34F56');
  const bytes = await dahua.snapshot(1);
  assert.deepEqual(bytes, fake.snapshot);
  const stream = await dahua.eventStream({ timeoutMs: 5000 });
  assert.equal(stream.status, 200);
  const chunks = [];
  const reading = (async () => {
    for await (const chunk of stream.stream) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes('Heartbeat')) {
        break;
      }
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.heartbeat();
  await reading;
  stream.close();
  assert.match(Buffer.concat(chunks).toString(), /--myboundary[\s\S]*Heartbeat/);
});
