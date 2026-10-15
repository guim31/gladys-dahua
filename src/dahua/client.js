// -----------------------------------------------------------------------------
// The Dahua CGI client of ONE device (a camera, a recorder or a doorbell):
// digest authentication, a small queue, and the reads and writes the
// integration needs. Everything is a GET under /cgi-bin/ answering
// `key=value` lines (src/dahua/parse.js).
//
// What the field taught rroller/dahua (MIT), applied here:
//   - the web server of a Dahua device is small: at most 2 requests in flight
//     per device, a dozen at once can wedge it;
//   - the `uri` signed in the digest is the exact string sent: the paths are
//     built here with literal brackets (`MotionDetect[0].Enable`), which every
//     firmware accepts, and signed as sent;
//   - the device locks the account after a few refused passwords (5 refusals
//     then 5 to 30 minutes on the firmwares documented). One 401 is not proof
//     of a wrong password (a nonce reused), so a refusal counts only when the
//     device refuses a fresh challenge it just gave; then the client stops
//     talking to the device
//     (`blocked`) until the configuration changes or the user tests the
//     connection. Never a retry loop on a password.
//   - a 200 whose body starts with `Error` is a refusal; 403 is an account
//     without the permission, never a wrong password; 404 on /cgi-bin/ is a
//     device without the CGI API.
// The password never appears in a log, an error or a URL.
// -----------------------------------------------------------------------------

import { authorization, basicAuthorization, parseChallenges } from './digest.js';
import { request as httpRequest } from './http.js';
import { isAccepted, isRefusal, parseKeyValue } from './parse.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable',
  AUTH: 'auth',
  BLOCKED: 'blocked',
  FORBIDDEN: 'forbidden',
  NO_API: 'no_api',
  REFUSED: 'refused',
  HTTP: 'http',
});

export class DahuaError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'DahuaError';
    this.kind = kind;
    this.status = status;
  }
}

export const CLIENT_TIMINGS = {
  requestTimeoutMs: 20_000,
  // A slot of the queue waits this long at most.
  queueTimeoutMs: 60_000,
};

// Refusals of a fresh challenge before the client stops: one. A password is
// never tried again on its own, far from the 5 attempts after which the
// documented firmwares lock the account (the fresh-challenge rule above keeps
// a reused nonce from counting).
export const MAX_AUTH_REFUSALS = 1;
const MAX_IN_FLIGHT = 2;

/** `name=value` pairs as a query string, brackets and dots left readable. */
export function query(params) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(String(value))}`)
    .join('&');
}

// Dahua parses the query itself: brackets, dots, commas stay literal (as the
// device's own web page sends them), everything else is percent-encoded.
const encodeComponent = (text) =>
  encodeURIComponent(text).replace(/%5B/gi, '[').replace(/%5D/gi, ']').replace(/%2C/gi, ',');

export class DahuaClient {
  /**
   * @param {object} options
   * @param {string} options.origin `http://192.0.2.10` or `https://…:port`
   * @param {string} options.username
   * @param {string} options.password
   * @param {Function} [options.request] HTTP seam (src/dahua/http.js)
   * @param {object} [options.timings] CLIENT_TIMINGS overrides
   */
  constructor({ origin, username, password, request, timings }) {
    this.origin = origin;
    this.username = username;
    this.password = password;
    this.http = request ?? httpRequest;
    this.timings = { ...CLIENT_TIMINGS, ...timings };
    // One challenge per device, shared by every channel and request.
    this.challenge = null;
    this.nc = 0;
    this.basic = false;
    this.refusals = 0;
    this.blocked = false;
    this.inFlight = 0;
    this.waiting = [];
  }

  /** Talk to the device again after a refused password (user action). */
  unblock() {
    this.blocked = false;
    this.refusals = 0;
  }

  // --- Queue ---------------------------------------------------------------------

  async slot() {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(new DahuaError(ERROR_KINDS.UNREACHABLE, 'The device is busy'));
      }, this.timings.queueTimeoutMs);
      timer.unref?.();
      entry.resolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiting.push(entry);
    });
    this.inFlight += 1;
  }

  release() {
    this.inFlight -= 1;
    this.waiting.shift()?.resolve();
  }

  // --- Requests ------------------------------------------------------------------

  /**
   * One authenticated GET. Streams (the event stream) resolve as soon as the
   * device accepted them and do not hold a slot of the queue.
   * @param {string} path `/cgi-bin/…?…`, already encoded
   * @param {object} [options]
   * @param {boolean} [options.stream]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{ status, headers, body?, stream?, close? }>}
   */
  async get(path, { stream = false, timeoutMs } = {}) {
    if (this.blocked) {
      throw new DahuaError(
        ERROR_KINDS.BLOCKED,
        'Stopped after refused credentials: change them or test the connection',
      );
    }
    if (!stream) {
      await this.slot();
    }
    try {
      return await this.authenticated(path, { stream, timeoutMs });
    } finally {
      if (!stream) {
        this.release();
      }
    }
  }

  async authenticated(path, { stream, timeoutMs }) {
    // Signed with a challenge the device just gave, in this very call: a 401
    // then is the password. Signed with a cached one, the device may simply
    // have moved to a new nonce: one more try with it.
    let fresh = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const headers = {};
      if (this.basic) {
        headers.Authorization = basicAuthorization(this.username, this.password);
      } else if (this.challenge) {
        this.nc += 1;
        headers.Authorization = authorization({
          challenge: this.challenge,
          username: this.username,
          password: this.password,
          method: 'GET',
          uri: path,
          nc: this.nc,
        });
      }
      let response;
      try {
        response = await this.http(`${this.origin}${path}`, {
          headers,
          stream,
          timeoutMs: timeoutMs ?? this.timings.requestTimeoutMs,
        });
      } catch (err) {
        throw new DahuaError(ERROR_KINDS.UNREACHABLE, describeNetworkError(err));
      }
      if (response.status !== 401) {
        if (headers.Authorization) {
          this.refusals = 0;
        }
        return response;
      }
      response.close?.();
      if (headers.Authorization && (fresh || this.basic)) {
        return this.refused();
      }
      const { digest, basic } = parseChallenges(response.headers?.['www-authenticate']);
      if (digest) {
        this.challenge = digest;
        this.nc = 0;
        this.basic = false;
      } else if (basic && !this.basic) {
        this.basic = true;
      } else {
        // A challenge we cannot answer: not a wrong password, never counted.
        throw new DahuaError(
          ERROR_KINDS.HTTP,
          'The device asks for an unknown authentication',
          401,
        );
      }
      fresh = true;
    }
    return this.refused();
  }

  refused() {
    this.refusals += 1;
    this.challenge = null;
    if (this.refusals >= MAX_AUTH_REFUSALS) {
      this.blocked = true;
    }
    throw new DahuaError(ERROR_KINDS.AUTH, 'User name or password refused', 401);
  }

  /** A GET whose answer must be a 200: the body as text. */
  async text(path, options) {
    const response = await this.get(path, options);
    const body = response.body?.toString('utf8') ?? '';
    if (response.status === 200) {
      return body;
    }
    throw httpError(response.status, body);
  }

  // --- Reads ---------------------------------------------------------------------

  /** `magicBox.cgi?action=<action>` as an object. */
  async magicBox(action) {
    return parseKeyValue(await this.text(`/cgi-bin/magicBox.cgi?action=${action}`));
  }

  /**
   * A configuration table, as `key=value` without the `table.` prefix. An
   * absent table answers an empty 200, a 400 or a 500 `Error`: all of them
   * read as `{}` (capabilities are judged on the keys present).
   */
  async getConfig(name) {
    let body;
    try {
      body = await this.text(`/cgi-bin/configManager.cgi?action=getConfig&name=${name}`);
    } catch (err) {
      // 400 or 500: a table this device does not have.
      if (err.kind === ERROR_KINDS.HTTP && err.status >= 400 && err.status !== 401) {
        return {};
      }
      throw err;
    }
    if (isRefusal(body)) {
      return {};
    }
    const table = {};
    for (const [key, value] of Object.entries(parseKeyValue(body))) {
      table[key.startsWith('table.') ? key.slice(6) : key] = value;
    }
    return table;
  }

  /** Write configuration fields; throws when the device refuses them. */
  async setConfig(fields) {
    const body = await this.text(`/cgi-bin/configManager.cgi?action=setConfig&${query(fields)}`);
    if (isRefusal(body) || !isAccepted(body)) {
      throw new DahuaError(ERROR_KINDS.REFUSED, 'The device refused the setting');
    }
  }

  /** Identity: serial, model, firmware, name, class. */
  async identity() {
    const info = await this.magicBox('getSystemInfo');
    const optional = async (action, key) => {
      try {
        return (await this.magicBox(action))[key] ?? null;
      } catch (err) {
        if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.BLOCKED) {
          throw err;
        }
        return null;
      }
    };
    let model = info.deviceType;
    if (!model || model === 'IP Camera' || model === '31') {
      model = info.updateSerial || (await optional('getDeviceType', 'type')) || null;
    }
    const version = await optional('getSoftwareVersion', 'version');
    return {
      serial: info.serialNumber || null,
      model: model || null,
      firmware: version ? version.split(',')[0] : null,
      name: await optional('getMachineName', 'name'),
      deviceClass: ((await optional('getDeviceClass', 'class')) ?? '').trim().toUpperCase() || null,
      vendor: await optional('getVendor', 'vendor'),
    };
  }

  /**
   * A snapshot of a channel (`channel` is the number the device expects,
   * usually index + 1). The 8-byte `dhav` trailer some doorbells append
   * after the JPEG end is cut.
   * @returns {Promise<Buffer>}
   */
  async snapshot(channel, { timeoutMs } = {}) {
    const response = await this.get(`/cgi-bin/snapshot.cgi?channel=${channel}`, { timeoutMs });
    if (response.status !== 200) {
      throw httpError(response.status, response.body?.toString('utf8') ?? '');
    }
    return stripTrailer(response.body ?? Buffer.alloc(0));
  }

  /** Whether `snapshot.cgi?channel=0` answers: the firmware counts channels from 0. */
  async snapshotsFromZero() {
    try {
      const response = await this.get('/cgi-bin/snapshot.cgi?channel=0');
      return response.status >= 200 && response.status < 300;
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        return null; // undecided
      }
      throw err;
    }
  }

  /** Siren and deterrence light state: `{ speaker, light }` or null. */
  async coaxialStatus(channel) {
    let body;
    try {
      body = await this.text(`/cgi-bin/coaxialControlIO.cgi?action=getStatus&channel=${channel}`);
    } catch (err) {
      if (
        err.kind === ERROR_KINDS.AUTH ||
        err.kind === ERROR_KINDS.BLOCKED ||
        err.kind === ERROR_KINDS.UNREACHABLE
      ) {
        throw err;
      }
      return null;
    }
    const status = parseKeyValue(body);
    const speaker = status['status.status.Speaker'];
    if (speaker === undefined) {
      return null;
    }
    const light = status['status.status.WhiteLight'];
    return {
      speaker: speaker.toLowerCase() === 'on',
      light: light === undefined ? null : light.toLowerCase() === 'on',
    };
  }

  /** Siren on or off (`type` 2) on a camera, through coaxialControlIO. */
  async coaxialControl(channel, type, on) {
    const body = await this.text(
      `/cgi-bin/coaxialControlIO.cgi?action=control&${query({
        channel,
        'info[0].Type': type,
        'info[0].IO': on ? 1 : 2,
      })}`,
    );
    if (isRefusal(body)) {
      throw new DahuaError(ERROR_KINDS.REFUSED, 'The device refused the command');
    }
  }

  /**
   * Open the door of a doorbell (VTO). Called once: a 400 is never retried,
   * a door has been seen opening despite it.
   */
  async openDoor(door) {
    const body = await this.text(
      `/cgi-bin/accessControl.cgi?action=openDoor&${query({ channel: door, UserID: 101, Type: 'Remote' })}`,
    );
    if (isRefusal(body)) {
      throw new DahuaError(ERROR_KINDS.REFUSED, 'The device refused to open the door');
    }
  }

  /** The event stream request (`codes=[All]`, filtered locally). */
  eventStream({ heartbeatSeconds = 5, timeoutMs = 60_000 } = {}) {
    return this.get(
      `/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=${heartbeatSeconds}`,
      { stream: true, timeoutMs },
    );
  }
}

/** The error of a non-200 answer. */
export function httpError(status, body = '') {
  if (status === 403) {
    return new DahuaError(ERROR_KINDS.FORBIDDEN, 'The account is not allowed to do this', 403);
  }
  if (status === 404 || status === 501) {
    return new DahuaError(
      ERROR_KINDS.NO_API,
      `No CGI API at this address (HTTP ${status})`,
      status,
    );
  }
  if (status === 200 && isRefusal(body)) {
    return new DahuaError(ERROR_KINDS.REFUSED, 'The device refused the request', status);
  }
  return new DahuaError(ERROR_KINDS.HTTP, `The device answered HTTP ${status}`, status);
}

function describeNetworkError(err) {
  const code = err?.code ? ` (${err.code})` : '';
  return `No answer from the device${code}`;
}

/** Cut what follows the last JPEG end marker when it is a `dhav` trailer. */
export function stripTrailer(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return bytes;
  }
  if (bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    return bytes;
  }
  const end = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (end > 0 && bytes.subarray(end + 2, end + 6).toString('latin1') === 'dhav') {
    return bytes.subarray(0, end + 2);
  }
  return bytes;
}
