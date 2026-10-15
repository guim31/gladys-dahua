// -----------------------------------------------------------------------------
// The Dahua hub: every configured device, followed live and read again on a
// timer.
//
//   - at start, each device is described once (identity, channels,
//     capabilities: src/dahua/device.js) and the description kept in /data,
//     so a device that is off at the next start keeps its features;
//   - the event stream of each device (src/dahua/events.js): motion, line
//     crossing, intrusion, person, vehicle, audio, doorbell rings, as they
//     happen. A ring and an object seen by a rule are pulses (1, then 0 a few
//     seconds later), as the core expects for a doorbell;
//   - the settings (motion detection, night vision, floodlight, siren,
//     privacy mask) are read every 5 minutes, every minute while an event
//     stream is down: the container refreshes itself, Gladys never polls
//     (should_poll: false, GladysAssistant/Gladys#3198);
//   - snapshots: a fresh image of a camera at each person detected or ring
//     (before the scene event, so a scene sending "the camera image" sends
//     the right one), on the timer chosen in the configuration, on demand.
//
// States go through publishChangedStates (only the changes, plus a heartbeat
// every 6 hours: the front shows "no recent value" past 48 hours), and only
// for the devices the user added: Gladys drops the others.
//
// Logs: info keeps the lifecycle (connected, a device lost and back, user
// commands); a problem that repeats is logged once, and once when it clears;
// the rest goes to debug (LOG_LEVEL=debug). Never a password, never an
// address with credentials.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { ERROR_KINDS } from './dahua/client.js';
import { DahuaDevice } from './dahua/device.js';
import { EventStream } from './dahua/events.js';
import { DETECTIONS, KINDS, interpret } from './dahua/model.js';
import {
  FEATURE_KEYS,
  buildDevice,
  channelIds,
  channelName,
  featureKeys,
  featureValues,
  platformId,
} from './devices.js';
import { toCameraImage } from './image.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  KIND_TEXT,
  REPORT_TEXT,
  SOURCE_NAMES,
  localized,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'dahua-hub' });

export const WIDGET_KEY = 'dahua';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  PERSON: 'person_detected',
  DOORBELL: 'doorbell_pressed',
});

export const HUB_TIMINGS = {
  refreshMs: 5 * 60_000,
  // While an event stream is down, the reads carry the states.
  fallbackRefreshMs: 60_000,
  heartbeatMs: 6 * 60 * 60_000,
  // A ring, an object crossing a line: 1, then 0 after this.
  pulseMs: 10_000,
  // One scene event per person or ring in this window, per channel: a
  // detection reported by two rules, or a long press, is one event.
  triggerSpacingMs: 15_000,
  // The core takes 12 images a minute per camera at most.
  imageSpacingMs: 6_000,
  // A scene event waits this long at most for the fresh image of its camera.
  eventImageWaitMs: 4_000,
  // The siren stops by itself after 10 to 15 s: read it again after this.
  sirenCheckMs: 20_000,
};

// Detections kept for the widget (with their image) and counted over 24 h.
export const MAX_DETECTIONS = 8;
const DAY_MS = 24 * 60 * 60_000;
const MAX_COUNTED = 5000;

// What a learned event adds to a channel (a feature its tables did not show).
const LEARNABLE = new Set(Object.values(DETECTIONS));

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

const devicesSignature = (config) =>
  JSON.stringify(config.devices.map((d) => [d.origin, d.username, d.password]));

export class DahuaHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/dahua/http.js)
   * @param {Function} [options.toImage] snapshot → camera image (src/image.js)
   * @param {boolean} [options.timers] periodic timers (off in most tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.streamTimings] STREAM_TIMINGS overrides
   * @param {object} [options.clientTimings] CLIENT_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({
    gladys,
    store,
    request,
    toImage,
    timers = true,
    timings,
    streamTimings,
    clientTimings,
    now,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.toImage = toImage ?? toCameraImage;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.streamTimings = streamTimings;
    this.clientTimings = clientTimings;
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.signature = null;
    /** By origin: DahuaDevice, EventStream, read state. */
    this.devices = new Map();
    this.streams = new Map();
    this.reads = new Map();
    /** By channel key: settings, latched detections, pulses, learned features. */
    this.settings = new Map();
    this.active = new Map();
    this.pulses = new Map();
    this.learned = new Map();
    this.lastTriggers = new Map();
    this.saved = { devices: {}, learned: {} };
    this.reading = null;
    this.discovery = null;
    /** Last image per channel key: { at, image }. */
    this.images = new Map();
    this.imageReads = new Map();
    /** Detections, newest first: { id, at, key, kind, imageKey }. */
    this.detections = [];
    this.detectionTimes = [];
    this.detectionCount = 0;
    this.thumbnails = new Map();
    this.online = new Map();
    this.transports = new Map();
    this.connection = null;
    this.refreshTimer = null;
    this.snapshotTimer = null;
    this.sirenTimer = null;
    this.stopped = false;
    /** Problems already logged, by key: their repeats go to debug. */
    this.warned = new Set();
  }

  get language() {
    return this.config?.language ?? 'en';
  }

  // --- Logs ------------------------------------------------------------------

  /** Log a problem once (`level` warn or error), its repeats at debug. */
  problem(key, message, level = 'warn') {
    if (this.warned.has(key)) {
      logger.debug(message);
      return;
    }
    this.warned.add(key);
    logger[level](message);
  }

  /** The problem `key` is gone: say so once, the next occurrence logs again. */
  resolved(key, message) {
    if (this.warned.delete(key) && message) {
      logger.info(message);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.saved = {
      devices: saved.devices && typeof saved.devices === 'object' ? saved.devices : {},
      learned: saved.learned && typeof saved.learned === 'object' ? saved.learned : {},
    };
    for (const [key, list] of Object.entries(this.saved.learned)) {
      if (Array.isArray(list)) {
        this.learned.set(key, new Set(list.filter((item) => LEARNABLE.has(item))));
      }
    }
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports.clear();
    this.connection = null;
    this.discovery = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const next = devicesSignature(config);
    const changed = next !== this.signature;
    this.config = config;
    if (changed) {
      this.closeStreams();
      this.signature = next;
      this.devices.clear();
      this.reads.clear();
      this.online.clear();
      for (const host of config.devices) {
        const device = new DahuaDevice({
          host,
          request: this.request,
          clientTimings: this.clientTimings,
        });
        const saved = this.saved.devices[host.origin];
        if (saved && typeof saved === 'object' && Array.isArray(saved.channels)) {
          device.restore(saved);
        }
        this.devices.set(host.origin, device);
        this.reads.set(host.origin, { ok: null, error: null, downSince: null });
      }
      if (config.invalidHosts.length > 0) {
        this.problem(
          'invalid-hosts',
          `Addresses not understood in the configuration: ${config.invalidHosts.join(', ')}`,
        );
      } else {
        this.resolved('invalid-hosts');
      }
    }
    // A new language or siren choice renames or adds features: the Discovery
    // tab shows them.
    this.discovery = null;
    if (this.devices.size === 0) {
      clearTimeout(this.refreshTimer);
      clearTimeout(this.snapshotTimer);
      await this.publishDevices();
      await this.publishConnectionStatus();
      return;
    }
    await this.refresh();
    if (changed) {
      this.openStreams();
    }
    this.scheduleRefresh();
    this.scheduleSnapshots();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.snapshotTimer);
    clearTimeout(this.sirenTimer);
    this.closeStreams();
    for (const timers of this.pulses.values()) {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    }
    this.pulses.clear();
    await this.store.flush();
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.timersEnabled || this.stopped || this.devices.size === 0) {
      return;
    }
    const allLive = [...this.streams.values()].every((stream) => stream.open);
    const wait = allLive ? this.timings.refreshMs : this.timings.fallbackRefreshMs;
    this.refreshTimer = setTimeout(async () => {
      await this.refresh();
      this.scheduleRefresh();
    }, wait);
  }

  scheduleSnapshots() {
    clearTimeout(this.snapshotTimer);
    const interval = this.config?.snapshotIntervalMs ?? 0;
    if (!this.timersEnabled || this.stopped || this.devices.size === 0 || interval <= 0) {
      return;
    }
    this.snapshotTimer = setTimeout(async () => {
      await this.snapshotAll();
      this.scheduleSnapshots();
    }, interval);
  }

  // --- Channels ----------------------------------------------------------------

  /** Every channel of every described device. */
  channels() {
    const list = [];
    for (const device of this.devices.values()) {
      const info = device.info;
      if (!info) {
        continue;
      }
      for (const channel of info.channels) {
        const entry = {
          device,
          origin: device.host.origin,
          host: device.label,
          serial: info.serial,
          kind: info.kind,
          model: info.model,
          deviceName: info.name,
          index: channel.index,
          number: channel.number,
          title: channel.title,
          caps: channel.caps,
        };
        entry.key = platformId(entry);
        entry.learned = this.learned.get(entry.key) ?? new Set();
        entry.settings = this.settings.get(entry.key) ?? {};
        list.push(entry);
      }
    }
    return list;
  }

  /** The channel of a Gladys external id, null when unknown. */
  findChannel(externalId) {
    if (!externalId) {
      return null;
    }
    return (
      this.channels().find((channel) => channelIds(this.gladys, channel).device === externalId) ??
      null
    );
  }

  isOnline(origin) {
    const read = this.reads.get(origin);
    return Boolean(read && (read.ok === true || this.streams.get(origin)?.open));
  }

  // --- Reading the devices -----------------------------------------------------------

  /** Read every device. Concurrent calls share the read. */
  refresh({ describe = false } = {}) {
    if (describe) {
      for (const device of this.devices.values()) {
        device.redescribe = true;
      }
    }
    this.reading ??= this.readAll().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  async readAll() {
    const devices = [...this.devices.values()];
    const results = await Promise.all(devices.map((device) => this.readDevice(device)));
    if (
      this.devices.size === 0 ||
      devices.some((device) => !this.devices.has(device.host.origin))
    ) {
      return false; // reconfigured while reading
    }
    await this.publishDevices();
    await this.publishAllStates();
    await this.afterChanges();
    return results.every(Boolean);
  }

  async readDevice(device) {
    const origin = device.host.origin;
    try {
      if (!device.info || device.redescribe) {
        device.redescribe = false;
        const info = await device.describe();
        this.saved.devices[origin] = info;
        this.save();
      }
      const settings = await device.readSettings();
      for (const [index, values] of settings) {
        const channel = device.channel(index);
        if (channel) {
          this.settings.set(
            platformId({ ...channel, serial: device.info.serial, kind: device.info.kind }),
            values,
          );
        }
      }
    } catch (err) {
      if (this.devices.get(origin) === device) {
        this.readFailed(device, err);
      }
      return false;
    }
    if (this.devices.get(origin) === device) {
      this.readSucceeded(device);
    }
    return true;
  }

  readSucceeded(device) {
    const read = this.reads.get(device.host.origin);
    const first = read.ok === null;
    const wasDown = read.ok === false;
    read.ok = true;
    read.error = null;
    const info = device.info;
    const label = `${info.model ?? 'Dahua'} at ${device.label}`;
    if (first) {
      logger.info(
        `Connected to ${label}: ${info.kind}, ${info.channels.length} channel(s), firmware ${info.firmware ?? '?'}`,
      );
    } else if (wasDown) {
      const minutes = Math.max(1, Math.round((this.now() - read.downSince) / 60_000));
      logger.info(`${label} answers again after ${minutes} min`);
    }
    this.warned.delete(`read-${device.host.origin}`);
    read.downSince = null;
    // A stream stopped by a refused password resumes once the device answers.
    const stream = this.streams.get(device.host.origin);
    if (stream && !stream.running && !this.stopped) {
      stream.restart();
    }
  }

  readFailed(device, err) {
    const read = this.reads.get(device.host.origin);
    if (read.ok !== false) {
      read.downSince = this.now();
    }
    read.ok = false;
    read.error = err;
    const level = err.kind === ERROR_KINDS.UNREACHABLE ? 'info' : 'warn';
    this.problem(
      `read-${device.host.origin}`,
      `Cannot read the device at ${device.label}: ${err.message}`,
      level,
    );
    if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.BLOCKED) {
      this.streams.get(device.host.origin)?.stop();
    }
  }

  save() {
    const learned = Object.fromEntries(
      [...this.learned.entries()].map(([key, set]) => [key, [...set]]),
    );
    this.saved.learned = learned;
    return this.store.save({ devices: this.saved.devices, learned });
  }

  // --- Event streams -----------------------------------------------------------------

  openStreams() {
    this.closeStreams();
    if (this.stopped) {
      return;
    }
    for (const device of this.devices.values()) {
      const stream = new EventStream({
        client: device.client,
        onEvent: (event) =>
          this.onEvent(device, event).catch((err) =>
            this.problem(
              `event-${device.label}`,
              `Cannot handle an event of ${device.label}: ${err.message}`,
            ),
          ),
        onOpen: () => this.streamOpened(device),
        onClose: (err) => this.streamClosed(device, err),
        timings: this.streamTimings,
        now: this.now,
      });
      this.streams.set(device.host.origin, stream);
      stream.start();
    }
  }

  closeStreams() {
    for (const stream of this.streams.values()) {
      stream.stop();
    }
    this.streams.clear();
  }

  streamOpened(device) {
    this.resolved(
      `stream-${device.host.origin}`,
      `Live events of ${device.label}: connected again`,
    );
    logger.debug(`Event stream of ${device.label} open`);
    this.scheduleRefresh();
    this.afterChanges().catch(() => {});
  }

  streamClosed(device, err) {
    const origin = device.host.origin;
    if (err.kind === ERROR_KINDS.BLOCKED || err.routine) {
      // A refused password: already said by the read that met it. A stream
      // recycled or closed after a long life: reopened at once, a routine.
      logger.debug(`Live events of ${device.label} closed: ${err.message}`);
    } else {
      // A device lost is lifecycle (info); a refused password or a forbidden
      // stream is a problem to fix (warn). Once per outage either way.
      const level = err.kind === ERROR_KINDS.UNREACHABLE ? 'info' : 'warn';
      this.problem(
        `stream-${origin}`,
        `Live events of ${device.label} interrupted: ${err.message}`,
        level,
      );
    }
    // Its Stop events are lost while it is closed: nothing stays detected.
    for (const channel of this.channels().filter((entry) => entry.origin === origin)) {
      if (this.active.get(channel.key)?.size) {
        this.active.set(channel.key, new Set());
        this.publishStates(channel).catch(() => {});
      }
    }
    if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.BLOCKED) {
      const read = this.reads.get(origin);
      if (read) {
        if (read.ok !== false) {
          read.downSince = this.now();
        }
        read.ok = false;
        read.error = err;
      }
    }
    this.scheduleRefresh();
    this.afterChanges().catch(() => {});
  }

  async onEvent(device, event) {
    const { channelIndex, effects, rule, source } = interpret(event);
    if (effects.length === 0) {
      logger.debug(`Event ${event.code} (${event.action}) of ${device.label}: ignored`);
      return;
    }
    const channels = this.channels().filter((entry) => entry.origin === device.host.origin);
    // A camera or a doorbell has one channel, whatever index its events carry.
    const channel =
      device.info?.kind === KINDS.RECORDER
        ? channels.find((entry) => entry.index === channelIndex)
        : channels[0];
    if (!channel) {
      logger.debug(
        `Event ${event.code} of ${device.label} channel ${channelIndex}: not configured`,
      );
      return;
    }
    logger.debug(`Event ${event.code} (${event.action}) on ${channelName(channel)}`);
    await this.learn(channel, effects);
    const active = this.active.get(channel.key) ?? new Set();
    this.active.set(channel.key, active);
    for (const effect of effects) {
      if (effect.pulse) {
        this.pulse(channel, effect.detection);
      } else if (effect.on) {
        active.add(effect.detection);
      } else {
        active.delete(effect.detection);
      }
    }
    await this.publishStates(channel);
    const started = (detection) =>
      effects.some((effect) => effect.detection === detection && effect.on);
    if (started(DETECTIONS.RING)) {
      await this.ring(channel);
    }
    if (started(DETECTIONS.PERSON)) {
      await this.personDetected(channel, { source, rule });
    }
  }

  /** An event of a kind the tables did not show: the channel gains its feature. */
  async learn(channel, effects) {
    const keys = featureKeys(channel);
    const missing = effects
      .map((effect) => effect.detection)
      .filter((detection) => LEARNABLE.has(detection) && !keys.includes(detection));
    if (missing.length === 0) {
      return;
    }
    const learned = this.learned.get(channel.key) ?? new Set();
    for (const detection of missing) {
      learned.add(detection);
    }
    this.learned.set(channel.key, learned);
    this.save();
    logger.info(
      `${channelName(channel)} reported ${missing.join(', ')}: feature added in Discover`,
    );
    await this.publishDevices();
  }

  // --- Rings, persons and their scene events ------------------------------------------

  /** One trigger per channel and window: true when this one may fire. */
  mayFire(key, channel) {
    const id = `${key}:${channel.key}`;
    const last = this.lastTriggers.get(id);
    if (last !== undefined && this.now() - last < this.timings.triggerSpacingMs) {
      return false;
    }
    this.lastTriggers.set(id, this.now());
    return true;
  }

  async ring(channel) {
    if (!this.mayFire(TRIGGERS.DOORBELL, channel)) {
      return;
    }
    const detection = this.remember(channel, 'ring');
    await this.imageFor(channel, detection);
    await this.fire(TRIGGERS.DOORBELL, {
      doorbell: channelIds(this.gladys, channel).device,
      doorbell_name: channelName(channel, this.language),
    });
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  async personDetected(channel, { source, rule }) {
    if (!this.mayFire(TRIGGERS.PERSON, channel)) {
      return;
    }
    const detection = this.remember(channel, 'person');
    await this.imageFor(channel, detection);
    const names = SOURCE_NAMES[this.language] ?? SOURCE_NAMES.en;
    await this.fire(TRIGGERS.PERSON, {
      camera: channelIds(this.gladys, channel).device,
      source: source ?? null,
      camera_name: channelName(channel, this.language),
      source_name: source ? names[source] : null,
      rule_name: rule ?? null,
    });
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Keep a detection for the widget. */
  remember(channel, kind) {
    this.detectionCount += 1;
    const detection = {
      id: `${this.now().toString(36)}${this.detectionCount.toString(36)}`,
      at: this.now(),
      key: channel.key,
      kind,
      imageKey: null,
    };
    this.detections.unshift(detection);
    for (const dropped of this.detections.splice(MAX_DETECTIONS)) {
      this.thumbnails.delete(dropped.imageKey);
    }
    this.detectionTimes.push(detection.at);
    if (this.detectionTimes.length > MAX_COUNTED) {
      this.detectionTimes.splice(0, this.detectionTimes.length - MAX_COUNTED);
    }
    return detection;
  }

  /** Detections over the last 24 hours, of one channel or all. */
  detectionsToday(key) {
    const since = this.now() - DAY_MS;
    if (key) {
      return this.detections.filter((entry) => entry.key === key && entry.at >= since).length;
    }
    this.detectionTimes = this.detectionTimes.filter((at) => at >= since);
    return this.detectionTimes.length;
  }

  /** A fresh image for a detection, waited for a few seconds at most. */
  async imageFor(channel, detection) {
    const read = this.cameraImage(channel).then((image) => {
      if (image && !detection.imageKey) {
        detection.imageKey = `det-${detection.id.replace(/[^a-z0-9]/g, '').slice(0, 40)}`;
        this.thumbnails.set(detection.imageKey, image.slice(image.indexOf(',') + 1));
      }
    });
    await Promise.race([read, delay(this.timings.eventImageWaitMs)]);
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.resolved('scene-event');
    } catch (err) {
      this.problem('scene-event', `Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Pulses ------------------------------------------------------------------

  /** A momentary detection: on now, off after `pulseMs`. */
  pulse(channel, detection) {
    const timers = this.pulses.get(channel.key) ?? new Map();
    this.pulses.set(channel.key, timers);
    clearTimeout(timers.get(detection));
    const timer = setTimeout(() => {
      timers.delete(detection);
      const current = this.channels().find((entry) => entry.key === channel.key);
      if (current && !this.stopped) {
        this.publishStates(current).catch(() => {});
      }
    }, this.timings.pulseMs);
    timer.unref?.();
    timers.set(detection, timer);
  }

  // --- Publishing to Gladys ----------------------------------------------------

  /** Whether the user added the device to Gladys. */
  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  async publishDevices() {
    const devices = this.channels().map((channel) =>
      buildDevice(this.gladys, channel, {
        language: this.language,
        allowSiren: this.config?.allowSiren ?? false,
      }),
    );
    const key = JSON.stringify(devices);
    if (key === this.discovery) {
      return;
    }
    try {
      // Even an empty list: the Discovery tab then shows no stale device.
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovery = key;
      this.resolved('discovery');
    } catch (err) {
      this.problem('discovery', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: describe the devices again (new rules…). */
  async rediscover() {
    this.discovery = null;
    if (!(await this.refresh({ describe: true }))) {
      await this.publishDevices();
    }
  }

  /** The user added a device: the SDK forgot its values, send them again. */
  async onDeviceCreated(device) {
    const channel = this.findChannel(device.external_id);
    if (!channel) {
      return;
    }
    await this.publishStates(channel);
    await this.publishTransports();
    if (this.isOnline(channel.origin)) {
      this.cameraImage(channel).catch(() => {});
    }
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  async publishAllStates() {
    for (const channel of this.channels()) {
      await this.publishStates(channel);
    }
  }

  /** The current values of one channel, sent if they changed. */
  async publishStates(channel) {
    const ids = channelIds(this.gladys, channel);
    if (!this.isCreated(ids.device)) {
      return;
    }
    const values = featureValues(channel, {
      online: this.isOnline(channel.origin),
      active: this.active.get(channel.key) ?? new Set(),
      pulses: new Set(this.pulses.get(channel.key)?.keys() ?? []),
    });
    const states = featureKeys(channel, { allowSiren: this.config?.allowSiren ?? false })
      .filter((key) => values[key] !== undefined && values[key] !== null)
      .map((key) =>
        typeof values[key] === 'object'
          ? { device_feature_external_id: ids.feature(key), text: values[key].text }
          : { device_feature_external_id: ids.feature(key), state: values[key] },
      );
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.resolved('states');
    } catch (err) {
      this.problem('states', `States of ${channelName(channel)} refused: ${err.message}`);
    }
  }

  /** After any change: devices offline and back, transports, status, widget. */
  async afterChanges() {
    let changed = false;
    for (const device of this.devices.values()) {
      const origin = device.host.origin;
      const online = this.isOnline(origin);
      const before = this.online.get(origin);
      if (before !== online) {
        changed = true;
        if (before !== undefined) {
          logger.info(`${device.label} is ${online ? 'online again' : 'offline'}`);
          await this.publishAllStates();
        }
      }
      this.online.set(origin, online);
    }
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (changed) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  async publishTransports() {
    const entries = [];
    for (const channel of this.channels()) {
      const externalId = channelIds(this.gladys, channel).device;
      if (!this.isCreated(externalId)) {
        continue;
      }
      const transport = this.isOnline(channel.origin)
        ? DEVICE_TRANSPORTS.LOCAL
        : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      for (const entry of entries) {
        this.transports.set(entry.external_id, entry.transport);
      }
      this.resolved('transports');
    } catch (err) {
      this.problem('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name, in the Configuration screen. */
  connectionStatus() {
    const config = this.config;
    if (!config || config.devices.length === 0) {
      let message = CONNECTION_TEXT.noHost;
      if (config?.noPassword.length > 0) {
        message = CONNECTION_TEXT.noPassword;
      } else if (config?.invalidHosts.length > 0) {
        message = CONNECTION_TEXT.invalidHost;
      }
      return { connected: false, message };
    }
    const reads = [...this.reads.values()];
    if (reads.some((read) => read.ok === null)) {
      return null; // first read not done yet
    }
    const failed = reads.filter((read) => read.ok === false);
    const refused = failed.find((read) =>
      [ERROR_KINDS.AUTH, ERROR_KINDS.BLOCKED].includes(read.error?.kind),
    );
    if (refused) {
      return { connected: false, message: ERROR_TEXT[ERROR_KINDS.BLOCKED] };
    }
    if (failed.length === reads.length) {
      return { connected: false, message: ERROR_TEXT[failed[0].error?.kind] ?? ERROR_TEXT.http };
    }
    if (config.noPassword.length > 0) {
      return { connected: true, message: CONNECTION_TEXT.noPassword };
    }
    if (failed.length > 0 || config.invalidHosts.length > 0) {
      return { connected: true, message: CONNECTION_TEXT.someDown };
    }
    // A stream still connecting at start is not news: only a lost one is.
    const lost = [...this.devices.values()].some(
      (device) =>
        !this.streams.get(device.host.origin)?.open &&
        this.warned.has(`stream-${device.host.origin}`),
    );
    if (lost) {
      return { connected: true, message: CONNECTION_TEXT.live };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    if (!status) {
      return;
    }
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.resolved('connection-status');
    } catch (err) {
      this.problem('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  // --- Camera images -------------------------------------------------------------

  /**
   * A fresh image of a channel, sent to Gladys when the camera is added.
   * Concurrent calls share the read; a read younger than `imageSpacingMs` is
   * reused (the core takes 12 images a minute per camera).
   * @returns {Promise<string|null>} the `image/jpg;base64,…` string
   */
  cameraImage(channel) {
    const last = this.images.get(channel.key);
    if (last && this.now() - last.at < this.timings.imageSpacingMs) {
      return Promise.resolve(last.image);
    }
    const running = this.imageReads.get(channel.key);
    if (running) {
      return running;
    }
    const read = this.readImage(channel).finally(() => this.imageReads.delete(channel.key));
    this.imageReads.set(channel.key, read);
    return read;
  }

  async readImage(channel) {
    let image;
    try {
      const bytes = await channel.device.snapshot(channel.index);
      image = await this.toImage(bytes);
      this.resolved(`image-${channel.key}`, `Images of ${channelName(channel)}: back`);
    } catch (err) {
      this.problem(`image-${channel.key}`, `No image from ${channelName(channel)}: ${err.message}`);
      return null;
    }
    this.images.set(channel.key, { at: this.now(), image });
    const externalId = channelIds(this.gladys, channel).device;
    if (this.isCreated(externalId)) {
      try {
        await this.gladys.publishCameraImage(externalId, image);
        this.resolved('camera-image');
      } catch (err) {
        this.problem('camera-image', `Image of ${channelName(channel)} refused: ${err.message}`);
      }
    }
    return image;
  }

  /** The timer of the configuration: every added channel online, one after the other. */
  async snapshotAll() {
    const half = (this.config?.snapshotIntervalMs ?? 0) / 2;
    for (const channel of this.channels()) {
      const externalId = channelIds(this.gladys, channel).device;
      const last = this.images.get(channel.key);
      // Skip a channel imaged less than half a period ago (a detection did it),
      // and a lens covered by the privacy mask (the image is black).
      if (
        !this.isOnline(channel.origin) ||
        !this.isCreated(externalId) ||
        channel.settings.privacy === true ||
        (last && this.now() - last.at < half)
      ) {
        continue;
      }
      await this.cameraImage(channel);
    }
  }

  /** Gladys asks for a fresh image (scene "send camera image", AI). */
  async getImage(device) {
    const channel = this.findChannel(device.external_id);
    if (!channel) {
      throw new Error(pick(ACTION_TEXT.unknownCamera, this.language));
    }
    const image = await this.cameraImage(channel);
    if (!image) {
      throw new Error(pick(ACTION_TEXT.snapshotFailed, this.language));
    }
    return image;
  }

  // --- Commands --------------------------------------------------------------------

  requireChannel(externalId) {
    if (this.devices.size === 0) {
      throw new Error(pick(ACTION_TEXT.notConfigured, this.language));
    }
    if (!externalId) {
      throw new Error(pick(ACTION_TEXT.pickCamera, this.language));
    }
    const channel = this.findChannel(externalId);
    if (!channel) {
      throw new Error(pick(ACTION_TEXT.unknownCamera, this.language));
    }
    return channel;
  }

  /** A command of a feature: motion detection, night vision, floodlight, siren, privacy. */
  async setValue(device, feature, value) {
    const channel = this.findChannel(device.external_id);
    const ids = channel ? channelIds(this.gladys, channel) : null;
    const key = ids
      ? Object.values(FEATURE_KEYS).find((name) => ids.feature(name) === feature.external_id)
      : null;
    const allowed = channel
      ? featureKeys(channel, { allowSiren: this.config?.allowSiren ?? false })
      : [];
    if (!key || !allowed.includes(key)) {
      throw new Error(`No command for ${feature.external_id}`);
    }
    const on = Number(value) === 1;
    const target = channel.device;
    const settings = { ...(this.settings.get(channel.key) ?? {}) };
    let done;
    try {
      switch (key) {
        case FEATURE_KEYS.DETECTION:
          await target.setDetection(channel.index, on);
          settings.detection = on;
          done = `motion detection ${on ? 'on' : 'off'}`;
          break;
        case FEATURE_KEYS.NIGHT_VISION: {
          const mode = String(value);
          await target.setNightVision(channel.index, mode);
          settings.nightVision = mode;
          done = `night vision ${mode}`;
          break;
        }
        case FEATURE_KEYS.FLOODLIGHT:
          await target.setFloodlight(channel.index, on);
          settings.floodlight = on;
          done = `floodlight ${on ? 'on' : 'off'}`;
          break;
        case FEATURE_KEYS.SIREN:
          await target.setSiren(on);
          settings.siren = on;
          done = `siren ${on ? 'on' : 'off'}`;
          if (on) {
            this.checkSirenLater();
          }
          break;
        case FEATURE_KEYS.PRIVACY:
          await target.setPrivacy(on);
          settings.privacy = on;
          done = `privacy mask ${on ? 'on' : 'off'}`;
          break;
        default:
          throw new Error(`No command for ${feature.external_id}`);
      }
    } catch (err) {
      logger.warn(`${channelName(channel)}: command failed: ${err.message}`);
      throw new Error(pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT.http, this.language), { cause: err });
    }
    logger.info(`${channelName(channel)}: ${done}`);
    this.settings.set(channel.key, settings);
    await this.publishStates({ ...channel, settings });
  }

  /** The siren stops by itself: read its state again a little later. */
  checkSirenLater() {
    clearTimeout(this.sirenTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.sirenTimer = setTimeout(() => {
      this.refresh().catch(() => {});
    }, this.timings.sirenCheckMs);
    this.sirenTimer.unref?.();
  }

  /** Scene action and widget: a fresh image now, sent to Gladys. */
  async refreshSnapshot(externalId) {
    const channel = this.requireChannel(externalId);
    logger.info(`Scene action: fresh image of ${channelName(channel)}`);
    const image = await this.cameraImage(channel);
    if (!image) {
      throw new Error(pick(ACTION_TEXT.snapshotFailed, this.language));
    }
    return image;
  }

  /**
   * Scene action: open the door of a doorbell. Disabled unless allowed in
   * the configuration; sent once, never retried (a door has been seen
   * opening despite an error answer).
   */
  async openDoor(externalId, door = 1) {
    if (!this.config?.allowDoorOpen) {
      throw new Error(pick(ACTION_TEXT.doorDisabled, this.language));
    }
    const channel = this.requireChannel(externalId);
    if (channel.kind !== KINDS.DOORBELL) {
      throw new Error(pick(ACTION_TEXT.notDoorbell, this.language));
    }
    try {
      await channel.device.openDoor(door);
    } catch (err) {
      logger.warn(
        `Scene action: door ${door} of ${channelName(channel)} not opened: ${err.message}`,
      );
      throw new Error(pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT.http, this.language), { cause: err });
    }
    logger.info(`Scene action: door ${door} of ${channelName(channel)} opened`);
  }

  // --- Configuration actions -------------------------------------------------------

  /**
   * "Test the connection": describe every device again (it also lifts the
   * stop after a refused password) and report, in four languages.
   */
  async testConnection() {
    if (this.devices.size === 0) {
      return this.connectionStatus().message;
    }
    // One more try of a refused password, asked by the user: its event
    // stream follows only if the read succeeds (readSucceeded).
    for (const device of this.devices.values()) {
      device.client.unblock();
    }
    await this.refresh({ describe: true });
    const lines = [...this.devices.values()].map((device) => {
      const read = this.reads.get(device.host.origin);
      return { device, read };
    });
    const ok = lines.filter(({ read }) => read.ok).length;
    logger.info(`Connection test: ${ok} of ${lines.length} device(s) answered`);
    return localized((language) =>
      lines
        .map(({ device, read }) => {
          const text = REPORT_TEXT[language];
          if (read.ok && device.info) {
            const info = device.info;
            return text.ok(
              device.label,
              info.model ?? 'Dahua',
              KIND_TEXT[language][info.kind],
              info.channels.length,
            );
          }
          return text.failed(
            device.label,
            pick(ERROR_TEXT[read.error?.kind] ?? ERROR_TEXT.http, language),
          );
        })
        .join(' '),
    );
  }

  /**
   * "Video stream address": the RTSP address of a channel, for the "RTSP
   * camera" integration of Gladys, with the user name and a PASSWORD
   * placeholder: the password is never shown nor logged.
   */
  streamUrl(externalId) {
    const channel = this.requireChannel(externalId);
    const host = new URL(channel.origin).hostname;
    const user = encodeURIComponent(channel.device.host.username);
    const rtsp = `rtsp://${user}:PASSWORD@${host}:554/cam/realmonitor?channel=${channel.number}&subtype=0`;
    logger.info(`Configuration action: stream address of ${channelName(channel)} shown`);
    return localized((language) => `${pick(ACTION_TEXT.stream, language)} ${rtsp}`);
  }

  // --- Widget ------------------------------------------------------------------------

  /** What the widget shows: the channels and the detections. */
  view() {
    return {
      configured: this.devices.size > 0,
      channels: this.channels().map((channel) => ({
        ...channel,
        online: this.isOnline(channel.origin),
        externalId: channelIds(this.gladys, channel).device,
      })),
      detections: this.detections,
      detectionsToday: (key) => this.detectionsToday(key),
      failed: [...this.reads.values()]
        .filter((read) => read.ok === false)
        .map((read) => read.error),
    };
  }

  /** The raw base64 of a detection image of the widget. */
  thumbnail(key) {
    const image = this.thumbnails.get(key);
    if (!image) {
      throw new Error(`Unknown image ${key}`);
    }
    return image;
  }
}
