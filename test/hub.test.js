// -----------------------------------------------------------------------------
// The integration end to end, against the fake Gladys of the SDK and three
// fake Dahua devices (test/helpers/world.js): discovery, states, events,
// triggers, commands, safety rules, recovery.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TRIGGERS } from '../src/hub.js';
import {
  BASE_CONFIG,
  SERIALS,
  cameraIds,
  createAll,
  createWorld,
  doorbellIds,
  recorderIds,
  settle,
} from './helpers/world.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const feature = (w, device, key) => {
  const found = w.fake.discoveredDevices.find((entry) => entry.external_id === device.device);
  return found?.features.find((entry) => entry.external_id === device.feature(key)) ?? null;
};

test('discovery: one device per camera, per recorder channel, per doorbell', async (t) => {
  const w = await world(t);
  const names = w.fake.discoveredDevices.map((device) => [device.name, device.model]);
  assert.deepEqual(names, [
    ['Entree', 'Dahua IPC-HFW3849T1-AS-PV'],
    ['FRONT STREET', 'Dahua DHI-NVR5464-16P-EI'],
    ['Enregistreur 2', 'Dahua DHI-NVR5464-16P-EI'],
    ['Portier', 'Dahua VTO2202F-P'],
  ]);
  assert.ok(w.fake.discoveredDevices.every((device) => device.should_poll === false));
  const camera = cameraIds(w.gladys);
  assert.deepEqual(
    w.fake.discoveredDevices[0].features.map((f) => f.external_id.slice(camera.device.length + 1)),
    [
      'image',
      'online',
      'motion',
      'line_crossing',
      'person',
      'vehicle',
      'detection',
      'night_vision',
      'floodlight',
      'siren',
      'privacy',
    ],
  );
  // The ONVIF and disabled slots of the recorder are not devices.
  assert.equal(feature(w, recorderIds(w.gladys, 3), 'image'), null);
  assert.ok(feature(w, recorderIds(w.gladys, 2), 'person'));
  assert.equal(feature(w, recorderIds(w.gladys, 1), 'person'), null);
  assert.ok(feature(w, doorbellIds(w.gladys), 'ring'));
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('the doorbell is reached with its own credentials', async (t) => {
  const w = await world(t);
  assert.equal(w.devices.doorbell.refusals, 0);
  assert.equal(w.devices.camera.refusals, 0);
});

test('no state before the devices are added; all of them once added', async (t) => {
  const w = await world(t);
  assert.equal(w.fake.states.length, 0);
  await createAll(w);
  const camera = cameraIds(w.gladys);
  assert.equal(w.fake.lastState(camera.feature('online')), 1);
  assert.equal(w.fake.lastState(camera.feature('motion')), 0);
  assert.equal(w.fake.lastState(camera.feature('detection')), 1);
  assert.equal(w.fake.lastState(camera.feature('night_vision')), 'auto');
  assert.equal(w.fake.lastState(camera.feature('floodlight')), 0);
  assert.equal(w.fake.lastState(camera.feature('siren')), 0);
  assert.equal(w.fake.lastState(camera.feature('privacy')), 0);
  // A first image of each added camera.
  assert.equal(w.fake.cameraImages.length, 4);
  assert.ok(w.fake.cameraImages.every((image) => image.image.startsWith('image/jpg;base64,')));
});

test('motion follows start and stop', async (t) => {
  const w = await world(t);
  await createAll(w);
  const motion = cameraIds(w.gladys).feature('motion');
  await w.emit('camera', 'motionStart');
  assert.equal(w.fake.lastState(motion), 1);
  await w.emit('camera', 'motionStop');
  assert.equal(w.fake.lastState(motion), 0);
});

test('a person crossing a line: pulse, fresh image, then one scene event', async (t) => {
  const w = await world(t);
  await createAll(w);
  const camera = cameraIds(w.gladys);
  const images = w.fake.cameraImages.length;
  w.clock.advance(60_000);
  await w.emit('camera', 'crossLineHuman');
  assert.equal(w.fake.lastState(camera.feature('person')), 1);
  assert.equal(w.fake.lastState(camera.feature('line_crossing')), 1);
  assert.equal(w.fake.cameraImages.length, images + 1, 'the image comes before the event');
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.PERSON,
      data: {
        camera: camera.device,
        source: 'line_crossing',
        camera_name: 'Entree',
        source_name: 'line crossing',
        rule_name: 'Portail',
      },
    },
  ]);
  // The same person reported again within the window: one event only.
  await w.emit('camera', 'crossLineHuman');
  assert.equal(w.fake.sceneEvents.length, 1);
  await sleep(80);
  await settle();
  assert.equal(w.fake.lastState(camera.feature('person')), 0, 'the pulse ends');
  await w.emit('camera', 'crossLineStop');
  assert.equal(w.fake.lastState(camera.feature('line_crossing')), 0);
  w.clock.advance(20_000);
  await w.emit('camera', 'crossLineHuman');
  assert.equal(w.fake.sceneEvents.length, 2, 'a new window, a new event');
});

test('a recorder event goes to the channel of its index', async (t) => {
  const w = await world(t);
  await createAll(w);
  await w.emit('recorder', 'smartHumanStart');
  const second = recorderIds(w.gladys, 2);
  assert.equal(w.fake.lastState(second.feature('person')), 1);
  assert.equal(w.fake.lastState(recorderIds(w.gladys, 1).feature('motion')), 0);
  assert.equal(w.fake.sceneEvents[0].data.camera, second.device);
  assert.equal(w.fake.sceneEvents[0].data.source, 'smart_motion');
  assert.equal(w.fake.sceneEvents[0].data.rule_name, null);
  await w.emit('recorder', 'smartHumanStop');
  assert.equal(w.fake.lastState(second.feature('person')), 0);
  // A channel the recorder does not have (ONVIF, unconfigured): dropped.
  await w.emit('recorder', 'Code=VideoMotion;action=Start;index=2');
  assert.equal(w.fake.sceneEvents.length, 1);
});

test('a ring: the doorbell pulses, its image is fresh, the trigger fires once', async (t) => {
  const w = await world(t);
  await createAll(w);
  const doorbell = doorbellIds(w.gladys);
  w.clock.advance(60_000);
  await w.emit('doorbell', 'ring');
  assert.equal(w.fake.lastState(doorbell.feature('ring')), 1);
  assert.deepEqual(w.fake.sceneEvents, [
    { key: TRIGGERS.DOORBELL, data: { doorbell: doorbell.device, doorbell_name: 'Portier' } },
  ]);
  assert.equal(w.fake.cameraImages.at(-1).device_external_id, doorbell.device);
  // A long press reported twice, and the door unlocked: no other event.
  await w.emit('doorbell', 'ring');
  await w.emit('doorbell', 'unlocked');
  assert.equal(w.fake.sceneEvents.length, 1);
  await sleep(80);
  await settle();
  assert.equal(w.fake.lastState(doorbell.feature('ring')), 0);
});

test('an audio alarm the tables did not show adds its feature, kept in /data', async (t) => {
  const w = await world(t);
  await createAll(w);
  const audio = cameraIds(w.gladys).feature('audio');
  assert.equal(feature(w, cameraIds(w.gladys), 'audio'), null);
  await w.emit('camera', 'audio');
  assert.ok(feature(w, cameraIds(w.gladys), 'audio'), 'proposed in Discover');
  await w.app.hub.store.flush();
  const saved = JSON.parse(await readFile(join(w.dataDir, 'dahua-state.json'), 'utf8'));
  assert.deepEqual(saved.learned[SERIALS.camera], ['audio']);
  // Once the user updated the device, its state follows.
  const updated = w.fake.discoveredDevices.find(
    (d) => d.external_id === cameraIds(w.gladys).device,
  );
  await w.fake.deviceCreated(updated);
  await w.emit('camera', 'audioStop');
  assert.equal(w.fake.lastState(audio), 0);
});

test('a dropped stream clears what was detected (its Stop is lost)', async (t) => {
  const w = await world(t);
  await createAll(w);
  const motion = cameraIds(w.gladys).feature('motion');
  await w.emit('camera', 'motionStart');
  assert.equal(w.fake.lastState(motion), 1);
  w.devices.camera.dropStreams();
  await settle();
  assert.equal(w.fake.lastState(motion), 0);
  await sleep(40);
  await settle();
  assert.equal(w.devices.camera.streams.size, 1, 'opened again');
});

test('commands: motion detection, night vision, floodlight, privacy', async (t) => {
  const w = await world(t);
  await createAll(w);
  const device = w.fake.discoveredDevices[0];
  const camera = cameraIds(w.gladys);
  const byKey = (key) => device.features.find((f) => f.external_id === camera.feature(key));
  const tables = w.devices.camera.tables;

  assert.equal((await w.fake.setValue(device, byKey('detection'), 0)).success, true);
  assert.equal(tables.MotionDetect['MotionDetect[0].Enable'], 'false');
  assert.equal(w.fake.lastState(camera.feature('detection')), 0);

  assert.equal((await w.fake.setValue(device, byKey('night_vision'), 'off')).success, true);
  assert.equal(tables.Lighting['Lighting[0][0].Mode'], 'Off');
  assert.equal(w.fake.lastState(camera.feature('night_vision')), 'off');

  assert.equal((await w.fake.setValue(device, byKey('floodlight'), 1)).success, true);
  assert.equal(tables.Lighting_V2['Lighting_V2[0][0][1].Mode'], 'Manual');
  assert.equal((await w.fake.setValue(device, byKey('floodlight'), 0)).success, true);
  assert.equal(tables.Lighting_V2['Lighting_V2[0][0][1].Mode'], 'Auto', 'back to its own mode');

  assert.equal((await w.fake.setValue(device, byKey('privacy'), 1)).success, true);
  assert.equal(tables.LeLensMask['LeLensMask[0].Enable'], 'true');

  // The settings read again agree.
  await w.hub.refresh();
  assert.equal(w.fake.lastState(camera.feature('privacy')), 1);
  assert.equal(w.fake.lastState(camera.feature('night_vision')), 'off');
});

test('a command the device refuses fails with a message, the state stays', async (t) => {
  const w = await world(t);
  await createAll(w);
  const device = w.fake.discoveredDevices[0];
  const detection = device.features.find((f) => f.external_id.endsWith(':detection'));
  delete w.devices.camera.tables.MotionDetect['MotionDetect[0].Enable'];
  const ack = await w.fake.setValue(device, detection, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the setting/);
  assert.equal(w.fake.lastState(cameraIds(w.gladys).feature('detection')), 1);
});

test('the siren: only when allowed, sent on channel 0', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, allow_siren: false } });
  assert.equal(feature(w, cameraIds(w.gladys), 'siren'), null);
  await w.fake.configUpdated({ ...BASE_CONFIG, allow_siren: true });
  await settle();
  const siren = feature(w, cameraIds(w.gladys), 'siren');
  assert.ok(siren);
  await createAll(w);
  const device = w.fake.discoveredDevices[0];
  assert.equal((await w.fake.setValue(device, siren, 1)).success, true);
  assert.deepEqual(w.devices.camera.coaxialCommands, [{ channel: 0, type: 2, io: 1 }]);
  assert.equal(w.fake.lastState(siren.external_id), 1);
  // Not allowed any more: refused even if Gladys still has the feature.
  await w.fake.configUpdated({ ...BASE_CONFIG, allow_siren: false });
  const ack = await w.fake.setValue(device, siren, 1);
  assert.equal(ack.success, false);
  assert.equal(w.devices.camera.coaxialCommands.length, 1);
});

test('opening the door: disabled by default, never a feature, a scene action once allowed', async (t) => {
  const w = await world(t);
  await createAll(w);
  // No device feature can open a door.
  for (const device of w.fake.discoveredDevices) {
    for (const f of device.features) {
      assert.ok(!['lock', 'opening-sensor'].includes(f.category), f.external_id);
      assert.doesNotMatch(f.external_id, /door|lock|open/);
    }
  }
  const doorbell = doorbellIds(w.gladys).device;
  const refused = await w.fake.sceneAction('open_door', { doorbell, door: '1' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /disabled/);
  assert.deepEqual(w.devices.doorbell.doorsOpened, []);

  await w.fake.configUpdated({ ...BASE_CONFIG, allow_door_open: true });
  const notDoorbell = await w.fake.sceneAction('open_door', {
    doorbell: cameraIds(w.gladys).device,
    door: '1',
  });
  assert.equal(notDoorbell.success, false);
  const ack = await w.fake.sceneAction('open_door', { doorbell, door: '2' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(w.devices.doorbell.doorsOpened, [2]);
});

test('a refused door is never sent twice', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, allow_door_open: true } });
  await createAll(w);
  const fake = w.devices.doorbell;
  const original = fake.answer.bind(fake);
  let sent = 0;
  fake.answer = (target, path, stream) => {
    if (target.pathname.includes('accessControl')) {
      sent += 1;
      return fake.text('Error\r\nBad Request!\r\n', 400);
    }
    return original(target, path, stream);
  };
  const ack = await w.fake.sceneAction('open_door', {
    doorbell: doorbellIds(w.gladys).device,
    door: '1',
  });
  assert.equal(ack.success, false);
  assert.equal(sent, 1);
});

test('a refused password stops that device only, before it locks the account', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, password_2: 'wrong-door-password' } });
  assert.equal(w.devices.doorbell.refusals, 1);
  for (let i = 0; i < 5; i += 1) {
    await w.hub.refresh();
  }
  assert.equal(w.devices.doorbell.refusals, 1, 'never tried again on its own');
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /lock the account/);
  // The other devices carry on.
  assert.equal(w.fake.discoveredDevices.length, 3);
  // Fixed: the new configuration resumes it.
  await w.fake.configUpdated({ ...BASE_CONFIG });
  await settle();
  assert.equal(w.fake.discoveredDevices.length, 4);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('a device that does not answer: unreachable, then back', async (t) => {
  const w = await world(t);
  await createAll(w);
  const camera = cameraIds(w.gladys);
  w.devices.camera.online = false;
  w.devices.camera.dropStreams();
  await settle();
  await w.hub.refresh();
  assert.equal(w.fake.lastState(camera.feature('online')), 0);
  assert.equal(
    w.fake.transports.filter((entry) => entry.device_external_id === camera.device).at(-1)
      .transport,
    'unreachable',
  );
  assert.equal(w.fake.connectionStatus.connected, true);
  assert.match(w.fake.connectionStatus.message.en, /some devices do not answer/);
  w.devices.camera.online = true;
  await w.hub.refresh();
  assert.equal(w.fake.lastState(camera.feature('online')), 1);
});

test('a device off at start keeps its features from /data', async (t) => {
  const first = await createWorld();
  await first.app.stop();
  const devices = first.devices;
  devices.camera.online = false;
  const w = await world(t, { devices, dataDir: first.dataDir });
  const camera = w.fake.discoveredDevices.find((d) => d.external_id === cameraIds(w.gladys).device);
  assert.ok(camera, 'still proposed');
  assert.equal(camera.features.length, 11);
  // Nothing secret in the file: no password, no RemoteDevice table.
  const text = await readFile(join(w.dataDir, 'dahua-state.json'), 'utf8');
  for (const secret of ['Secret-Dahua-1', 'Door-Secret-2', 'CameraSecret0', 'Password']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('test the connection: one line per device, in four languages', async (t) => {
  const w = await world(t);
  w.devices.recorder.online = false;
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  const message = ack.data.message;
  assert.deepEqual(Object.keys(message), ['en', 'fr', 'de', 'es']);
  assert.match(message.en, /192\.0\.2\.10: IPC-HFW3849T1-AS-PV \(camera\), 1 channel\(s\)\./);
  assert.match(message.en, /192\.0\.2\.20: The device does not answer/);
  assert.match(message.fr, /192\.0\.2\.30 : VTO2202F-P \(portier\)/);
});

test('test the connection lifts the stop after a refused password', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, password_2: 'wrong' } });
  assert.equal(w.devices.doorbell.refusals, 1);
  const ack = await w.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /192\.0\.2\.30: User name or password refused/);
  // One more try, asked by the user: never a loop.
  assert.equal(w.devices.doorbell.refusals, 2);
});

test('the video stream address never holds the password', async (t) => {
  const w = await world(t);
  const ack = await w.fake.action('stream_url', { camera: recorderIds(w.gladys, 2).device });
  assert.equal(ack.success, true);
  assert.match(
    ack.data.message.en,
    /rtsp:\/\/admin:PASSWORD@192\.0\.2\.20:554\/cam\/realmonitor\?channel=2&subtype=0/,
  );
  assert.ok(!JSON.stringify(ack).includes('Secret-Dahua-1'));
  const none = await w.fake.action('stream_url', {});
  assert.equal(none.success, false);
});

test('a fresh image on demand and from a scene', async (t) => {
  const w = await world(t);
  await createAll(w);
  const device = w.fake.discoveredDevices[0];
  const ack = await w.fake.getImage(device);
  assert.equal(ack.success, true);
  assert.match(ack.data.image, /^image\/jpg;base64,/);
  w.clock.advance(60_000);
  const images = w.fake.cameraImages.length;
  const scene = await w.fake.sceneAction('refresh_snapshot', { camera: device.external_id });
  assert.equal(scene.success, true, scene.error);
  assert.equal(w.fake.cameraImages.length, images + 1);
  w.devices.camera.snapshotStatus = 500;
  w.clock.advance(60_000);
  const failed = await w.fake.sceneAction('refresh_snapshot', { camera: device.external_id });
  assert.equal(failed.success, false);
});

test('a covered lens is not imaged by the timer', async (t) => {
  const w = await world(t);
  w.devices.camera.tables.LeLensMask['LeLensMask[0].Enable'] = 'true';
  await w.hub.refresh();
  await createAll(w);
  w.clock.advance(10 * 60_000);
  const before = w.fake.cameraImages.filter(
    (image) => image.device_external_id === cameraIds(w.gladys).device,
  ).length;
  await w.hub.snapshotAll();
  const after = w.fake.cameraImages.filter(
    (image) => image.device_external_id === cameraIds(w.gladys).device,
  ).length;
  assert.equal(after, before);
});

test('no device configured: a clear status, no request', async (t) => {
  const w = await world(t, { config: { language: 'fr' } });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /Enter the address/);
  assert.deepEqual(w.fake.discoveredDevices, []);
  assert.equal(w.devices.camera.requests.length, 0);
  const ack = await w.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /Enter the address/);
});

test('a device without password: not contacted, the status asks for it', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, password: '' } });
  assert.equal(w.devices.camera.requests.length, 0);
  assert.equal(w.devices.camera.refusals, 0);
  assert.equal(w.fake.discoveredDevices.length, 1, 'the doorbell, with its own password');
  assert.match(w.fake.connectionStatus.message.en, /Enter the password/);
  const none = await world(t, { config: { hosts: '192.0.2.10' } });
  assert.equal(none.fake.connectionStatus.connected, false);
  assert.match(none.fake.connectionStatus.message.en, /Enter the password/);
});

test('names follow the language of the configuration', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, language: 'de' } });
  const camera = w.fake.discoveredDevices[0];
  assert.equal(
    camera.features.find((f) => f.external_id.endsWith(':privacy')).name,
    'Privatsphäre-Maske',
  );
  const nightVision = camera.features.find((f) => f.external_id.endsWith(':night_vision'));
  assert.deepEqual(
    nightVision.supported_options.map((option) => [option.value, option.label]),
    [
      ['auto', 'Auto'],
      ['on', 'An'],
      ['off', 'Aus'],
    ],
  );
  assert.equal(w.fake.discoveredDevices[2].name, 'Enregistreur 2');
});
