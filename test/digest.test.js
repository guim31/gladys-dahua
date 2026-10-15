// -----------------------------------------------------------------------------
// HTTP Digest: the RFC 2617 example, SHA-256, the challenges real Dahua
// firmwares send (quoted commas, "auth,auth-int", Basic only).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorization,
  basicAuthorization,
  parseChallenge,
  parseChallenges,
} from '../src/dahua/digest.js';

test('the response of the RFC 2617 example', () => {
  const header = authorization({
    challenge: {
      realm: 'testrealm@host.com',
      qop: 'auth,auth-int',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      opaque: '5ccc069c403ebaf9f0171e9517f40e41',
    },
    username: 'Mufasa',
    password: 'Circle Of Life',
    method: 'GET',
    uri: '/dir/index.html',
    nc: 1,
    cnonce: '0a4f113b',
  });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('SHA-256 when the device asks for it, and the RFC 2069 form without qop', () => {
  const sha = authorization({
    challenge: { realm: 'r', nonce: 'n', qop: 'auth', algorithm: 'SHA-256' },
    username: 'u',
    password: 'p',
    method: 'GET',
    uri: '/x',
    nc: 1,
    cnonce: 'c',
  });
  assert.match(sha, /response="[0-9a-f]{64}"/);
  assert.match(sha, /algorithm=SHA-256/);
  const old = authorization({
    challenge: { realm: 'r', nonce: 'n' },
    username: 'u',
    password: 'p',
    method: 'GET',
    uri: '/x',
    nc: 1,
  });
  assert.doesNotMatch(old, /qop=/);
});

test('the challenges of Dahua firmwares are read, the strongest first', () => {
  assert.equal(
    parseChallenge('Digest realm="Login to 4KS2", qop="auth", nonce="a"').realm,
    'Login to 4KS2',
  );
  assert.equal(
    parseChallenge('Digest realm="Login to device, channel 1", qop="auth", nonce="abc"').realm,
    'Login to device, channel 1',
  );
  const both = parseChallenges([
    'Digest realm="r", qop="auth", nonce="md5", algorithm=MD5',
    'Digest realm="r", qop="auth", nonce="sha", algorithm=SHA-256',
  ]);
  assert.equal(both.digest.nonce, 'sha');
  assert.deepEqual(parseChallenges('Basic realm="Device_CGI"'), { digest: null, basic: true });
  assert.equal(parseChallenge('Bearer x'), null);
  assert.equal(
    basicAuthorization('admin', 'pw'),
    `Basic ${Buffer.from('admin:pw').toString('base64')}`,
  );
});
