// -----------------------------------------------------------------------------
// The configuration as typed: addresses (with a port, HTTPS, IPv6), the two
// groups of credentials, the refusal of a password typed in an address, and
// the defaults of the manifest.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseHost, parseHosts } from '../src/config.js';

test('an address is a host, an optional port and an optional scheme', () => {
  assert.deepEqual(parseHost('192.0.2.10'), { origin: 'http://192.0.2.10', label: '192.0.2.10' });
  assert.deepEqual(parseHost(' 192.0.2.10:8080 '), {
    origin: 'http://192.0.2.10:8080',
    label: '192.0.2.10:8080',
  });
  assert.deepEqual(parseHost('https://nvr.lan'), { origin: 'https://nvr.lan', label: 'nvr.lan' });
  assert.deepEqual(parseHost('http://192.0.2.10:80'), {
    origin: 'http://192.0.2.10',
    label: '192.0.2.10',
  });
  assert.equal(parseHost('[2001:db8::10]:81').origin, 'http://[2001:db8::10]:81');
});

test('an address with credentials, a path or another scheme is refused', () => {
  for (const bad of [
    'admin:secret@192.0.2.10',
    'http://admin@192.0.2.10',
    'rtsp://192.0.2.10',
    '192.0.2.10/cgi-bin',
    'bad host',
    '',
    'a..b',
  ]) {
    assert.equal(parseHost(bad), null, bad);
  }
});

test('a list of addresses: commas, spaces, new lines; duplicates dropped; never a password echoed', () => {
  const { hosts, invalid } = parseHosts(
    '192.0.2.10, 192.0.2.11\n192.0.2.10;admin:pw@192.0.2.12 x/y',
  );
  assert.deepEqual(
    hosts.map((host) => host.label),
    ['192.0.2.10', '192.0.2.11'],
  );
  assert.deepEqual(invalid, ['…@…', 'x/y']);
});

test('two groups of devices, each with its own credentials; the first group wins a duplicate', () => {
  const config = normalizeConfig({
    hosts: '192.0.2.10, 192.0.2.20',
    username: ' installer ',
    password: ' spaced ',
    hosts_2: '192.0.2.30, 192.0.2.10',
    username_2: '',
    password_2: 'other',
  });
  assert.deepEqual(
    config.devices.map(({ label, group, username, password }) => [
      label,
      group,
      username,
      password,
    ]),
    [
      ['192.0.2.10', 1, 'installer', ' spaced '],
      ['192.0.2.20', 1, 'installer', ' spaced '],
      ['192.0.2.30', 2, 'admin', 'other'],
    ],
  );
});

test('an address without a password is never contacted', () => {
  const config = normalizeConfig({ hosts: '192.0.2.10', hosts_2: '192.0.2.30', password_2: 'pw' });
  assert.deepEqual(
    config.devices.map((device) => device.label),
    ['192.0.2.30'],
  );
  assert.deepEqual(config.noPassword, ['192.0.2.10']);
});

test('the defaults: images every 5 minutes, siren and door off, French names', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config.devices, []);
  assert.equal(config.snapshotIntervalMs, 5 * 60_000);
  assert.equal(config.allowSiren, false);
  assert.equal(config.allowDoorOpen, false);
  assert.equal(config.language, 'fr');
  assert.equal(DEFAULT_CONFIG.allow_siren, false);
  assert.equal(DEFAULT_CONFIG.allow_door_open, false);
});

test('booleans arriving as strings, unknown options falling back to the defaults', () => {
  const config = normalizeConfig({
    allow_siren: 'true',
    allow_door_open: 'false',
    snapshot_interval: '7',
    language: 'it',
  });
  assert.equal(config.allowSiren, true);
  assert.equal(config.allowDoorOpen, false);
  assert.equal(config.snapshotIntervalMs, 5 * 60_000);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ snapshot_interval: '0' }).snapshotIntervalMs, 0);
});
