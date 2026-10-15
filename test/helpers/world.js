// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, three fake Dahua devices (a
// camera, a recorder with two Dahua cameras, a doorbell with its own
// password), a temporary /data and a manual clock, with the integration wired
// on top through registerHandlers. No periodic timer runs unless
// `timers: true` (with node:test mock timers): the tests read the devices
// with `world.hub.refresh()` and push events with `world.emit(...)`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { FakeDahua, PASSWORD, USERNAME, network } from './fakeDahua.js';

// The integration logs its lifecycle; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const ORIGINS = {
  camera: 'http://192.0.2.10',
  recorder: 'http://192.0.2.20',
  doorbell: 'http://192.0.2.30',
};

export const DOORBELL_PASSWORD = 'Door-Secret-2';

export const SERIALS = {
  camera: '8F0AB12CDE34F56',
  recorder: '7D0CE45AB98F123',
  doorbell: '6B2DF90AC17E345',
};

export const BASE_CONFIG = {
  hosts: '192.0.2.10, 192.0.2.20',
  username: USERNAME,
  password: PASSWORD,
  hosts_2: '192.0.2.30',
  username_2: USERNAME,
  password_2: DOORBELL_PASSWORD,
  snapshot_interval: '5',
  allow_siren: true,
  allow_door_open: false,
  language: 'en',
};

/** A manual clock. */
export function createClock(start = Date.UTC(2026, 9, 15, 18, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/** Let the streams, the event handlers and the fake network settle. */
export async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function createDevices() {
  return {
    camera: new FakeDahua({ name: 'camera' }),
    recorder: new FakeDahua({ name: 'recorder' }),
    doorbell: new FakeDahua({ name: 'doorbell', password: DOORBELL_PASSWORD }),
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.devices] fake devices by name
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.created] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {boolean} [options.timers]
 * @param {object} [options.timings] HUB_TIMINGS overrides
 */
export async function createWorld({
  clock = createClock(),
  devices = createDevices(),
  config = BASE_CONFIG,
  created = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-dahua-')),
  timings = {},
  streamTimings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config, devices: created });
  const request = network(
    Object.fromEntries(Object.entries(devices).map(([name, device]) => [ORIGINS[name], device])),
  );
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request,
    timers,
    timings: { pulseMs: 50, eventImageWaitMs: 200, ...timings },
    streamTimings: {
      quickRetryMs: 20,
      failureBaseMs: 20,
      failureMaxMs: 40,
      ...streamTimings,
    },
    now: clock.now,
  });
  const world = {
    gladys,
    fake: gladys.fake,
    devices,
    app,
    hub: app.hub,
    clock,
    dataDir,
    /** Send an event (fixture name or raw block) from a device, then let it be handled. */
    async emit(name, event) {
      devices[name].emit(event);
      await settle();
    },
  };
  if (connect) {
    await gladys.connect();
    await app.ready;
    await settle();
  }
  return world;
}

/** External ids of a channel of the fixtures. */
export const ids = (gladys, platformId) => gladys.externalIds('camera', platformId);
export const cameraIds = (gladys) => ids(gladys, SERIALS.camera);
export const doorbellIds = (gladys) => ids(gladys, SERIALS.doorbell);
export const recorderIds = (gladys, channel) => ids(gladys, `${SERIALS.recorder}-ch${channel}`);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  await settle();
}

export { FakeDahua, PASSWORD, USERNAME };
