// -----------------------------------------------------------------------------
// The event stream of one device: `eventManager.cgi?action=attach&codes=[All]`
// kept open, cut into parts (src/dahua/parse.js), each event handed over.
//
// `codes=[All]` and a local filter: some firmwares refuse a long list of codes
// (400, 500) or accept it and go silent. A heartbeat every 5 seconds proves the
// stream alive; 60 seconds without a byte and it is closed and opened again.
//
// Reconnection, as rroller/dahua measured it: a stream that lived and carried
// data reopens at once (a minute or more) or after 10 s; one that brought
// nothing waits 60 s, doubling up to 10 minutes. A healthy stream is recycled
// every hour (± 10 %): some firmwares keep heartbeating but stop reporting.
// A refused password stops the stream: the client is blocked (src/dahua/
// client.js) and only a new configuration or a test of the connection
// resumes it.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './client.js';
import { MultipartSplitter, boundaryOf, parseEvent } from './parse.js';

export const STREAM_TIMINGS = {
  heartbeatSeconds: 5,
  idleTimeoutMs: 60_000,
  recycleMs: 60 * 60_000,
  quickRetryMs: 10_000,
  longLifeMs: 60_000,
  failureBaseMs: 60_000,
  failureMaxMs: 10 * 60_000,
};

const jitter = (ms, random) => Math.round(ms * (0.9 + 0.2 * random()));

export class EventStream {
  /**
   * @param {object} options
   * @param {import('./client.js').DahuaClient} options.client
   * @param {(event) => void} options.onEvent
   * @param {() => void} [options.onOpen]
   * @param {(err) => void} [options.onClose] err is a DahuaError or an Error
   * @param {object} [options.timings] STREAM_TIMINGS overrides
   * @param {() => number} [options.random]
   * @param {() => number} [options.now]
   */
  constructor({ client, onEvent, onOpen, onClose, timings, random, now }) {
    this.client = client;
    this.onEvent = onEvent;
    this.onOpen = onOpen ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.timings = { ...STREAM_TIMINGS, ...timings };
    this.random = random ?? Math.random;
    this.now = now ?? (() => Date.now());
    this.running = false;
    this.current = null;
    this.retryTimer = null;
    this.recycleTimer = null;
    this.failures = 0;
    this.open = false;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.recycleTimer);
    this.current?.close?.();
    this.current = null;
    this.open = false;
  }

  /** Reconnect now (after a new configuration or an unblock). */
  restart() {
    this.stop();
    this.failures = 0;
    this.start();
  }

  async connect() {
    if (!this.running) {
      return;
    }
    const startedAt = this.now();
    let received = false;
    let recycled = false;
    let error = null;
    let response;
    try {
      response = await this.client.eventStream({
        heartbeatSeconds: this.timings.heartbeatSeconds,
        timeoutMs: this.timings.idleTimeoutMs,
      });
    } catch (err) {
      error = err;
    }
    if (!this.running) {
      response?.close?.();
      return;
    }
    if (response && response.status !== 200) {
      response.close?.();
      error = new Error(`The event stream was refused (HTTP ${response.status})`);
      error.kind = response.status === 403 ? ERROR_KINDS.FORBIDDEN : ERROR_KINDS.HTTP;
      response = null;
    }
    if (response) {
      this.current = response;
      this.open = true;
      this.onOpen();
      clearTimeout(this.recycleTimer);
      this.recycleTimer = setTimeout(
        () => {
          // Recycle: close, the loop below reopens at once.
          recycled = true;
          this.current?.close?.();
        },
        jitter(this.timings.recycleMs, this.random),
      );
      this.recycleTimer.unref?.();
      const splitter = new MultipartSplitter(
        boundaryOf(response.headers?.['content-type']),
        (part) => {
          received = true;
          const event = parseEvent(part);
          if (event) {
            try {
              this.onEvent(event);
            } catch {
              // One bad event never ends the stream.
            }
          }
        },
      );
      try {
        for await (const chunk of response.stream) {
          if (!this.running) {
            break;
          }
          received = true;
          splitter.push(Buffer.from(chunk));
        }
        error = new Error('The event stream ended');
      } catch (err) {
        error = err;
      }
      clearTimeout(this.recycleTimer);
      response.close?.();
      this.current = null;
      this.open = false;
    }
    if (!this.running) {
      return;
    }
    error.kind ??= ERROR_KINDS.UNREACHABLE;
    if (error.kind === ERROR_KINDS.AUTH || error.kind === ERROR_KINDS.BLOCKED) {
      this.onClose(error);
      this.running = false; // resumed by restart()
      return;
    }
    const lived = this.now() - startedAt;
    let wait;
    if (recycled || (received && lived >= this.timings.longLifeMs)) {
      this.failures = 0;
      wait = 0;
    } else if (received) {
      this.failures = 0;
      wait = jitter(this.timings.quickRetryMs, this.random);
    } else {
      this.failures += 1;
      wait = jitter(
        Math.min(this.timings.failureMaxMs, this.timings.failureBaseMs * 2 ** (this.failures - 1)),
        this.random,
      );
    }
    // Reopened at once (recycled, or a long-lived stream the device closed):
    // a routine, not an outage.
    error.routine = wait === 0;
    this.onClose(error);
    this.retryTimer = setTimeout(() => this.connect(), wait);
    this.retryTimer.unref?.();
  }
}
