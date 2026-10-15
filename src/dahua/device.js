// -----------------------------------------------------------------------------
// One configured Dahua device (a camera, a recorder or a doorbell): what it
// is (read once, src/dahua/model.js), the settings it is in now (read on the
// hub's timer), and the commands it takes. Its client (src/dahua/client.js)
// carries the digest state and the queue; its event stream
// (src/dahua/events.js) is opened by the hub.
//
// Reads are tables read whole (every channel at once): a recorder costs the
// same few requests as a camera. Writes name one field and are checked
// against the `OK` of the device.
// -----------------------------------------------------------------------------

import { DahuaClient, ERROR_KINDS } from './client.js';
import {
  KINDS,
  NIGHT_VISION,
  channelCapabilities,
  kindOf,
  liveProfile,
  recorderChannels,
  titleNames,
} from './model.js';

// Night vision modes read from the device, back to the feature values. A
// mode of the device's own (ZoomPrio, SmartIR…) is an automatic one.
const NIGHT_VISION_VALUES = Object.fromEntries(
  Object.entries(NIGHT_VISION).map(([value, mode]) => [mode, value]),
);

// coaxialControlIO: the siren is type 2; on a camera the status is read on
// channel 1 and the command sent on channel 0 (rroller/dahua).
const SIREN_TYPE = 2;

export class DahuaDevice {
  /**
   * @param {object} options
   * @param {{ origin, label, username, password }} options.host
   * @param {Function} [options.request] HTTP seam
   * @param {object} [options.clientTimings]
   */
  constructor({ host, request, clientTimings }) {
    this.host = host;
    this.client = new DahuaClient({
      origin: host.origin,
      username: host.username,
      password: host.password,
      request,
      timings: clientTimings,
    });
    /** What the device is: null until read (or restored from /data). */
    this.info = null;
    /** Live profile and floodlight mode before "on", per channel index. */
    this.profiles = new Map();
    this.floodlightModes = new Map();
  }

  get label() {
    return this.host.label;
  }

  // --- What the device is ------------------------------------------------------

  /**
   * Read the identity, the channels and their capabilities.
   * @returns {Promise<object>} the description (nothing secret: kept in /data)
   */
  async describe() {
    const client = this.client;
    const identity = await client.identity();
    if (!identity.serial) {
      throw Object.assign(new Error('The device does not report its serial number'), {
        kind: ERROR_KINDS.HTTP,
      });
    }
    const kind = kindOf(identity);
    const [motion, smartMotion, rules, lighting, lightingV2] = await Promise.all([
      client.getConfig('MotionDetect'),
      client.getConfig('SmartMotionDetect'),
      client.getConfig('VideoAnalyseRule'),
      client.getConfig('Lighting'),
      client.getConfig('Lighting_V2'),
    ]);
    const lensMask = kind === KINDS.RECORDER ? {} : await client.getConfig('LeLensMask');
    const coaxial = kind === KINDS.CAMERA ? await client.coaxialStatus(1) : null;
    let indexes = [0];
    let titles = new Map();
    if (kind === KINDS.RECORDER) {
      // The RemoteDevice table holds each camera's password: read, used for
      // the channel list, dropped.
      const titleTable = await client.getConfig('ChannelTitle');
      titles = titleNames(titleTable);
      indexes = recorderChannels(await client.getConfig('RemoteDevice'), titleTable);
    }
    // Old firmwares count snapshot channels from 0; never a doorbell.
    const zeroBased = kind === KINDS.DOORBELL ? false : (await client.snapshotsFromZero()) === true;
    const tables = { motion, smartMotion, rules, lighting, lightingV2, lensMask };
    this.info = {
      serial: identity.serial,
      model: identity.model,
      firmware: identity.firmware,
      name: identity.name,
      kind,
      zeroBased,
      channels: indexes.map((index) => ({
        index,
        number: zeroBased ? index : index + 1,
        title: titles.get(index) ?? null,
        caps: channelCapabilities(tables, index, { kind, model: identity.model, coaxial }),
      })),
    };
    return this.info;
  }

  /** Restore a description read before (the device is off at start). */
  restore(info) {
    this.info = info;
  }

  channel(index) {
    return this.info?.channels.find((channel) => channel.index === index) ?? null;
  }

  // --- Settings ------------------------------------------------------------------

  /**
   * The settings of every channel now: `Map<index, { detection, nightVision,
   * floodlight, siren, privacy }>` (null: the channel has not this control).
   */
  async readSettings() {
    const channels = this.info?.channels ?? [];
    const needs = (test) => channels.some((channel) => test(channel.caps));
    const client = this.client;
    const read = (name, wanted) => (wanted ? client.getConfig(name) : Promise.resolve({}));
    const lightingWanted = needs((caps) => caps.nightVision || caps.whiteLight !== null);
    const [motion, videoInMode, lighting, lightingV2, lensMask] = await Promise.all([
      read(
        'MotionDetect',
        needs((caps) => caps.detectionSwitch),
      ),
      read('VideoInMode', lightingWanted),
      read(
        'Lighting',
        needs((caps) => caps.nightVision),
      ),
      read(
        'Lighting_V2',
        needs((caps) => caps.whiteLight !== null),
      ),
      read(
        'LeLensMask',
        needs((caps) => caps.lensMask !== null),
      ),
    ]);
    const siren = needs((caps) => caps.siren) ? await client.coaxialStatus(1) : null;
    const settings = new Map();
    for (const { index, caps } of channels) {
      const profile = liveProfile(videoInMode, index);
      this.profiles.set(index, profile);
      const value = (key) => (key === undefined ? null : key);
      const enable = (text) => (text === undefined ? null : text === 'true');
      const lightingMode = value(
        lighting[`Lighting[${index}][${profile}].Mode`] ?? lighting[`Lighting[${index}][0].Mode`],
      );
      let floodlight = null;
      if (caps.whiteLight !== null) {
        const mode =
          lightingV2[`Lighting_V2[${index}][${profile}][${caps.whiteLight}].Mode`] ??
          lightingV2[`Lighting_V2[${index}][0][${caps.whiteLight}].Mode`];
        floodlight = mode === undefined ? null : mode === 'Manual';
        if (mode && mode !== 'Manual') {
          this.floodlightModes.set(index, mode);
        }
      }
      settings.set(index, {
        detection: caps.detectionSwitch ? enable(motion[`MotionDetect[${index}].Enable`]) : null,
        nightVision:
          caps.nightVision && lightingMode !== null
            ? (NIGHT_VISION_VALUES[lightingMode] ?? 'auto')
            : null,
        floodlight,
        siren: caps.siren ? (siren?.speaker ?? null) : null,
        privacy:
          caps.lensMask !== null ? enable(lensMask[`LeLensMask[${caps.lensMask}].Enable`]) : null,
      });
    }
    return settings;
  }

  // --- Commands ------------------------------------------------------------------

  setDetection(index, on) {
    return this.client.setConfig({ [`MotionDetect[${index}].Enable`]: on ? 'true' : 'false' });
  }

  setNightVision(index, value) {
    const mode = NIGHT_VISION[value];
    if (!mode) {
      throw new Error(`Unknown night vision mode ${value}`);
    }
    const profile = this.profiles.get(index) ?? 0;
    return this.client.setConfig({ [`Lighting[${index}][${profile}].Mode`]: mode });
  }

  /** On: forced on. Off: back to the mode it had (automatic by default). */
  setFloodlight(index, on) {
    const row = this.channel(index)?.caps.whiteLight;
    if (row === null || row === undefined) {
      throw new Error('This channel has no white light');
    }
    const profile = this.profiles.get(index) ?? 0;
    const mode = on ? 'Manual' : (this.floodlightModes.get(index) ?? 'Auto');
    return this.client.setConfig({ [`Lighting_V2[${index}][${profile}][${row}].Mode`]: mode });
  }

  setSiren(on) {
    return this.client.coaxialControl(0, SIREN_TYPE, on);
  }

  setPrivacy(on) {
    const entry = this.info?.channels[0]?.caps.lensMask;
    if (entry === null || entry === undefined) {
      throw new Error('This device has no privacy mask');
    }
    return this.client.setConfig({ [`LeLensMask[${entry}].Enable`]: on ? 'true' : 'false' });
  }

  openDoor(door) {
    return this.client.openDoor(door);
  }

  snapshot(index, options) {
    const channel = this.channel(index);
    return this.client.snapshot(channel ? channel.number : index + 1, options);
  }
}
