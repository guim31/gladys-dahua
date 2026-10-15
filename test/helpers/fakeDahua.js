// -----------------------------------------------------------------------------
// Simulated Dahua devices, built from the fixtures (test/fixtures/dahua): a
// `request` double for the client (src/dahua/http.js) that checks the HTTP
// Digest authentication like a device does (a new nonce on every challenge,
// `Connection: close`), answers the CGI API (magicBox, configManager get and
// set, snapshot, coaxialControlIO, accessControl) and keeps event streams
// open, written part by part like the multipart stream of a device.
// `serve()` exposes the same device over real HTTP on 127.0.0.1, for the test
// of the node:http transport (nothing leaves the machine).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import jpeg from 'jpeg-js';

process.env.LOG_LEVEL ??= 'silent';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/dahua/${name}`, import.meta.url), 'utf8'));

export const EVENTS = fixture('events.json');
export const USERNAME = 'admin';
export const PASSWORD = 'Secret-Dahua-1';
const REALM = 'Login to 8F0AB12CDE34F56';
const BOUNDARY = 'myboundary';

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/** A small valid JPEG (a grey frame). */
export function smallJpeg(width = 64, height = 36, shade = 120) {
  const data = Buffer.alloc(width * height * 4, shade);
  return Buffer.from(jpeg.encode({ width, height, data }, 80).data);
}

/** The parameters of an `Authorization: Digest …` header. */
function parseAuthorization(header) {
  const match = String(header ?? '').match(/^Digest\s+(.*)$/is);
  if (!match) {
    return null;
  }
  const params = {};
  for (const [, key, quoted, bare] of match[1].matchAll(
    /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi,
  )) {
    params[key.toLowerCase()] = quoted !== undefined ? quoted : bare;
  }
  return params;
}

/** `key=value` lines into an object, and back. */
const parseLines = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
const toLines = (object) =>
  Object.entries(object)
    .map(([key, value]) => `${key}=${value}\r\n`)
    .join('');

export class FakeDahua {
  /**
   * @param {object} options
   * @param {string} options.name fixture name: camera, recorder or doorbell
   * @param {string} [options.username]
   * @param {string} [options.password]
   */
  constructor({ name, username = USERNAME, password = PASSWORD }) {
    const data = fixture(`${name}.json`);
    this.name = name;
    this.username = username;
    this.password = password;
    this.magicBox = data.magicBox;
    this.tables = Object.fromEntries(
      Object.entries(data.tables).map(([table, text]) => [
        table,
        Object.fromEntries(
          Object.entries(parseLines(text)).map(([key, value]) => [
            key.replace(/^table\./, ''),
            value,
          ]),
        ),
      ]),
    );
    this.coaxial = data.coaxial ? { ...data.coaxial } : null;
    this.online = true;
    this.snapshot = smallJpeg();
    this.snapshotStatus = 200;
    this.requests = [];
    this.refusals = 0;
    this.nonces = new Set();
    this.streams = new Set();
    this.streamAttempts = 0;
    this.streamStatus = 200;
    this.doorsOpened = [];
    this.coaxialCommands = [];
    this.request = this.request.bind(this);
  }

  // --- HTTP ----------------------------------------------------------------------

  /** The `request` seam of src/dahua/http.js. */
  async request(url, { headers = {}, stream = false } = {}) {
    const target = new URL(url);
    const path = `${target.pathname}${target.search}`;
    this.requests.push({ path, authorized: Boolean(headers.Authorization) });
    if (!this.online) {
      const err = new Error('connect EHOSTUNREACH');
      err.code = 'EHOSTUNREACH';
      throw err;
    }
    if (!this.authorized(headers.Authorization, path)) {
      return this.challenge();
    }
    return this.answer(target, path, stream);
  }

  /** A fresh nonce on every challenge, as the devices do. */
  challenge() {
    const nonce = randomBytes(8).toString('hex');
    this.nonces.add(nonce);
    return {
      status: 401,
      headers: {
        'www-authenticate': `Digest realm="${REALM}", qop="auth", nonce="${nonce}", opaque="${md5(REALM)}"`,
      },
      body: Buffer.from('401 Unauthorized'),
    };
  }

  authorized(header, path) {
    const params = parseAuthorization(header);
    if (!params) {
      return false;
    }
    if (!this.nonces.has(params.nonce) || params.uri !== path) {
      return false;
    }
    const ha1 = md5(`${params.username}:${REALM}:${this.password}`);
    const ha2 = md5(`GET:${params.uri}`);
    const expected = md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:auth:${ha2}`);
    const ok = params.username === this.username && params.response === expected;
    if (!ok) {
      this.refusals += 1;
    }
    return ok;
  }

  text(body, status = 200) {
    return { status, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body) };
  }

  answer(target, path, stream) {
    const action = target.searchParams.get('action');
    switch (target.pathname) {
      case '/cgi-bin/magicBox.cgi':
        return this.magicBox[action]
          ? this.text(this.magicBox[action])
          : this.text('Error\r\nBad Request!\r\n', 400);
      case '/cgi-bin/configManager.cgi':
        return action === 'getConfig'
          ? this.getConfig(target.searchParams.get('name'))
          : this.setConfig(path);
      case '/cgi-bin/snapshot.cgi': {
        const channel = Number(target.searchParams.get('channel'));
        if (this.snapshotStatus !== 200) {
          return this.text('Error\r\n', this.snapshotStatus);
        }
        if (channel < 1 || channel > this.channelCount()) {
          return this.text('Error\r\nBad Request!\r\n', 400);
        }
        return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: this.snapshot };
      }
      case '/cgi-bin/coaxialControlIO.cgi':
        return this.coaxialAnswer(target);
      case '/cgi-bin/accessControl.cgi':
        if (this.name !== 'doorbell') {
          return this.text('Error\r\nBad Request!\r\n', 400);
        }
        this.doorsOpened.push(Number(target.searchParams.get('channel')));
        return this.text('OK\r\n');
      case '/cgi-bin/eventManager.cgi':
        return this.openStream(stream);
      default:
        return this.text('Error\r\n', 404);
    }
  }

  channelCount() {
    return this.name === 'recorder' ? 4 : 1;
  }

  getConfig(name) {
    const table = this.tables[name];
    if (!table) {
      return this.text('Error\r\nBad Request!\r\n', 400);
    }
    return this.text(
      toLines(
        Object.fromEntries(Object.entries(table).map(([key, value]) => [`table.${key}`, value])),
      ),
    );
  }

  setConfig(path) {
    const fields = path
      .slice(path.indexOf('action=setConfig&') + 'action=setConfig&'.length)
      .split('&')
      .map((pair) => pair.split('=').map((part) => decodeURIComponent(part)));
    for (const [key] of fields) {
      const table = this.tables[key.split(/[[.]/)[0]];
      if (!table || !Object.hasOwn(table, `${key}`)) {
        return this.text('Error\r\n');
      }
    }
    for (const [key, value] of fields) {
      this.tables[key.split(/[[.]/)[0]][key] = value;
    }
    return this.text('OK\r\n');
  }

  coaxialAnswer(target) {
    if (!this.coaxial) {
      return this.text('Error\r\nBad Request!\r\n', 400);
    }
    if (target.searchParams.get('action') === 'getStatus') {
      return this.text(
        `status.status.Speaker=${this.coaxial.Speaker}\r\nstatus.status.WhiteLight=${this.coaxial.WhiteLight}\r\n`,
      );
    }
    const type = Number(target.searchParams.get('info[0].Type'));
    const io = Number(target.searchParams.get('info[0].IO'));
    this.coaxialCommands.push({ channel: Number(target.searchParams.get('channel')), type, io });
    if (type === 2) {
      this.coaxial.Speaker = io === 1 ? 'On' : 'Off';
    }
    return this.text('OK\r\n');
  }

  // --- Event stream ----------------------------------------------------------------

  openStream(stream) {
    this.streamAttempts += 1;
    if (this.streamStatus !== 200) {
      return this.text('Error\r\n', this.streamStatus);
    }
    const body = new PassThrough();
    this.streams.add(body);
    body.on('close', () => this.streams.delete(body));
    const response = {
      status: 200,
      headers: { 'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}` },
      stream: body,
      close: () => body.destroy(),
    };
    if (!stream) {
      throw new Error('The event stream must be requested as a stream');
    }
    return response;
  }

  /** Write one part on every open stream. */
  writePart(text) {
    const payload = Buffer.from(text, 'utf8');
    const part = `--${BOUNDARY}\r\nContent-Type: text/plain\r\nContent-Length: ${payload.length}\r\n\r\n${text}\r\n`;
    for (const stream of this.streams) {
      stream.write(part);
    }
  }

  /** Send an event block of the fixtures (or a raw one). */
  emit(nameOrBlock) {
    this.writePart(EVENTS[nameOrBlock] ?? nameOrBlock);
  }

  heartbeat() {
    this.writePart('Heartbeat');
  }

  /** Close every open stream, as a device rebooting does. */
  dropStreams() {
    for (const stream of this.streams) {
      stream.destroy();
    }
  }

  // --- Real HTTP, for the transport test ---------------------------------------------

  /** Serve this device on 127.0.0.1; resolves `{ origin, close }`. */
  serve() {
    const server = http.createServer(async (req, res) => {
      const url = `http://${req.headers.host}${req.url}`;
      const answer = await this.request(url, {
        headers: { Authorization: req.headers.authorization },
        stream: req.url.includes('eventManager'),
      }).catch(() => ({ status: 500, headers: {}, body: Buffer.from('Error') }));
      res.writeHead(answer.status, answer.headers);
      if (answer.stream) {
        // A device sends the headers of its stream at once.
        res.flushHeaders();
        answer.stream.pipe(res);
        res.on('close', () => answer.close());
      } else {
        res.end(answer.body);
      }
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({
          origin: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise((done) => {
              server.closeAllConnections();
              server.close(done);
            }),
        });
      });
    });
  }
}

/**
 * Several devices behind one `request` seam, routed by origin.
 * @param {Record<string, FakeDahua>} byOrigin
 */
export function network(byOrigin) {
  return (url, options) => {
    const device = byOrigin[new URL(url).origin];
    if (!device) {
      const err = new Error('connect EHOSTUNREACH');
      err.code = 'EHOSTUNREACH';
      return Promise.reject(err);
    }
    return device.request(url, options);
  };
}
