// -----------------------------------------------------------------------------
// What a device is and can do, from its own answers (the fixtures), and what
// its events mean.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyValue, parseEvent } from '../src/dahua/parse.js';
import {
  DETECTIONS,
  KINDS,
  channelCapabilities,
  interpret,
  ivsRules,
  kindOf,
  lensMaskEntry,
  liveProfile,
  recorderChannels,
  titleNames,
  whiteLightRow,
} from '../src/dahua/model.js';
import { EVENTS, fixture } from './helpers/fakeDahua.js';

const table = (device, name) =>
  Object.fromEntries(
    Object.entries(parseKeyValue(fixture(`${device}.json`).tables[name] ?? '')).map(([k, v]) => [
      k.replace(/^table\./, ''),
      v,
    ]),
  );

test('the kind: the class first, the model else', () => {
  assert.equal(kindOf({ deviceClass: 'VTO', model: 'x' }), KINDS.DOORBELL);
  assert.equal(kindOf({ deviceClass: 'NVR', model: 'x' }), KINDS.RECORDER);
  assert.equal(kindOf({ deviceClass: 'XVR' }), KINDS.RECORDER);
  assert.equal(kindOf({ deviceClass: 'IPC', model: 'IPC-HDW5831R-ZE' }), KINDS.CAMERA);
  assert.equal(kindOf({ deviceClass: null, model: 'DHI-VTO2202F-P' }), KINDS.DOORBELL);
  assert.equal(kindOf({ deviceClass: null, model: 'AD410' }), KINDS.DOORBELL);
  assert.equal(kindOf({ deviceClass: null, model: 'DHI-NVR4108HS-8P-4KS2' }), KINDS.RECORDER);
  assert.equal(kindOf({}), KINDS.CAMERA);
});

test('a recorder: its enabled, non-ONVIF slots, its titles', () => {
  const remote = table('recorder', 'RemoteDevice');
  const titles = table('recorder', 'ChannelTitle');
  assert.deepEqual(recorderChannels(remote, titles), [0, 1]);
  assert.deepEqual(recorderChannels({ 'RemoteDevice[3].Enable': 'true' }, {}), [3]);
  // An analog recorder: no slot, every titled channel.
  assert.deepEqual(recorderChannels({}, titles), [0, 1, 2, 3]);
  assert.equal(titleNames(titles).get(0), 'FRONT STREET');
});

test('the capabilities of the camera of the fixtures', () => {
  const tables = {
    motion: table('camera', 'MotionDetect'),
    smartMotion: table('camera', 'SmartMotionDetect'),
    rules: table('camera', 'VideoAnalyseRule'),
    lighting: table('camera', 'Lighting'),
    lightingV2: table('camera', 'Lighting_V2'),
    lensMask: table('camera', 'LeLensMask'),
  };
  // The disabled intrusion rule does not count.
  assert.deepEqual(ivsRules(tables.rules, 0), { lineCrossing: true, intrusion: false });
  assert.equal(whiteLightRow(tables.lightingV2, 0), 1);
  assert.equal(lensMaskEntry(tables.lensMask), 0);
  const caps = channelCapabilities(tables, 0, {
    kind: KINDS.CAMERA,
    model: 'IPC-HFW3849T1-AS-PV',
    coaxial: null,
  });
  assert.deepEqual(caps, {
    motion: true,
    detectionSwitch: true,
    lineCrossing: true,
    intrusion: false,
    person: true,
    vehicle: true,
    ring: false,
    nightVision: true,
    whiteLight: 1,
    siren: true,
    lensMask: 0,
  });
  // Without the AS-PV model nor a coaxial answer: no siren.
  assert.equal(
    channelCapabilities(tables, 0, { kind: KINDS.CAMERA, model: 'IPC-HDW5831R-ZE', coaxial: null })
      .siren,
    false,
  );
});

test('a recorder channel: no privacy mask, no siren; smart motion only where its row is', () => {
  const tables = {
    motion: table('recorder', 'MotionDetect'),
    smartMotion: table('recorder', 'SmartMotionDetect'),
    rules: {},
    lighting: {},
    lightingV2: {},
    lensMask: { 'LeLensMask[0].Enable': 'false' },
  };
  const device = { kind: KINDS.RECORDER, model: 'DHI-NVR5464-16P-EI', coaxial: {} };
  const first = channelCapabilities(tables, 0, device);
  const second = channelCapabilities(tables, 1, device);
  assert.equal(first.person, false);
  assert.equal(second.person, true);
  assert.equal(first.lensMask, null);
  assert.equal(first.siren, false);
});

test('the live profile of a channel', () => {
  assert.equal(liveProfile({ 'VideoInMode[0].Config[0]': '2' }, 0), 2);
  assert.equal(
    liveProfile({ 'VideoInMode[0].Config[0]': '0', 'VideoInMode[0].ConfigEx': 'Night' }, 0),
    1,
  );
  assert.equal(liveProfile({ 'VideoInMode[1].Config[0]': '1' }, 1), 1);
  assert.equal(liveProfile({}, 0), 0);
});

test('events: motion latches, a rule with a Human pulses a person, a ring is State 1 or 2', () => {
  const read = (name) => interpret(parseEvent(EVENTS[name]));
  assert.deepEqual(read('motionStart').effects, [
    { detection: DETECTIONS.MOTION, on: true, pulse: false },
  ]);
  assert.deepEqual(read('motionStop').effects, [
    { detection: DETECTIONS.MOTION, on: false, pulse: false },
  ]);
  const crossing = read('crossLineHuman');
  assert.deepEqual(crossing.effects, [
    { detection: DETECTIONS.LINE_CROSSING, on: true, pulse: false },
    { detection: DETECTIONS.PERSON, on: true, pulse: true },
  ]);
  assert.equal(crossing.rule, 'Portail');
  assert.equal(crossing.source, 'line_crossing');
  assert.deepEqual(read('ruleWithSemicolon').effects[1], {
    detection: DETECTIONS.VEHICLE,
    on: true,
    pulse: true,
  });
  assert.equal(read('smartHumanStart').channelIndex, 1);
  assert.equal(read('smartHumanStart').source, 'smart_motion');
  assert.deepEqual(read('ring').effects, [{ detection: DETECTIONS.RING, on: true, pulse: true }]);
  assert.equal(read('ring').channelIndex, 0);
  // State 8 is the door unlocked: not a ring.
  assert.deepEqual(read('unlocked').effects, []);
  assert.deepEqual(read('audio').effects, [
    { detection: DETECTIONS.AUDIO, on: true, pulse: false },
  ]);
  // AlarmLocal: its index is an alarm input, not a channel; not handled.
  assert.deepEqual(read('alarmLocal').effects, []);
});
