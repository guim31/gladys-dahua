#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of a real Dahua device, with the very client of the
// integration: what the integration would see, without Gladys.
//
//   DAHUA_PASSWORD=… node scripts/probe.mjs <address> [user] [seconds]
//
// It reads the identity, the channels and their capabilities, the settings,
// takes one snapshot, and listens to the event stream (30 seconds by
// default), printing the code, action and index of each event. It writes
// nothing to the device: no setConfig, no siren, no door. It prints neither
// the password, nor the full serial number (its last 4 characters only), nor
// the RemoteDevice table of a recorder (which holds its cameras' passwords).
// One refused password stops it at once: the device locks the account after
// a few.
//
// Not part of the Docker image (only index.js and src/ are copied).
// -----------------------------------------------------------------------------

import { parseHost } from '../src/config.js';
import { DahuaDevice } from '../src/dahua/device.js';
import { EventStream } from '../src/dahua/events.js';
import { jpegSize } from '../src/image.js';

const [address, user = 'admin', seconds = '30'] = process.argv.slice(2);
const password = process.env.DAHUA_PASSWORD ?? '';
const host = parseHost(address);
if (!host || !password) {
  console.error('Usage: DAHUA_PASSWORD=… node scripts/probe.mjs <address> [user] [seconds]');
  process.exit(2);
}

const mask = (serial) => (serial ? `…${String(serial).slice(-4)}` : '?');
const line = (label, value) => console.log(`${label.padEnd(22)} ${value}`);

const device = new DahuaDevice({ host: { ...host, username: user, password } });

let info;
try {
  info = await device.describe();
} catch (err) {
  console.error(`Cannot read ${host.label}: ${err.message} (${err.kind ?? 'error'})`);
  process.exit(1);
}

line('Address', host.label);
line('Model', info.model ?? '?');
line('Kind', info.kind);
line('Firmware', info.firmware ?? '?');
line('Serial', mask(info.serial));
line('Snapshots from 0', info.zeroBased);
for (const channel of info.channels) {
  const caps = Object.entries(channel.caps)
    .filter(([, value]) => value !== false && value !== null)
    .map(([key, value]) => (value === true ? key : `${key}=${value}`))
    .join(', ');
  line(`Channel ${channel.index + 1}`, `${channel.title ?? ''} [${caps}]`);
}

try {
  const settings = await device.readSettings();
  for (const [index, values] of settings) {
    line(`Settings ${index + 1}`, JSON.stringify(values));
  }
} catch (err) {
  line('Settings', `not read: ${err.message}`);
}

try {
  const started = Date.now();
  const bytes = await device.snapshot(info.channels[0]?.index ?? 0);
  const size = jpegSize(bytes);
  line(
    'Snapshot',
    `${Math.round(bytes.length / 1024)} KB, ${size ? `${size.width}×${size.height}` : 'not a JPEG'}, ${Date.now() - started} ms`,
  );
} catch (err) {
  line('Snapshot', `failed: ${err.message}`);
}

console.log(`\nListening to the events for ${seconds} s (move in front of a camera, ring)…`);
const stream = new EventStream({
  client: device.client,
  onEvent: (event) => {
    const object = event.data?.Object?.ObjectType;
    const state = event.data?.State;
    console.log(
      `${new Date().toISOString()} ${event.code} ${event.action} index=${event.index}` +
        `${object ? ` object=${object}` : ''}${state !== undefined ? ` state=${state}` : ''}`,
    );
  },
  onOpen: () => console.log('Event stream open'),
  onClose: (err) => console.log(`Event stream closed: ${err.message}`),
});
stream.start();
await new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000));
stream.stop();
console.log('Done.');
process.exit(0);
