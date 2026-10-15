// -----------------------------------------------------------------------------
// What a Dahua device is and can do, read from its own answers (never from a
// label): kind (camera, recorder, doorbell), channels, and per channel the
// detections and the controls it has. And what an event of its stream means.
//
// Rules from rroller/dahua (MIT):
//   - a capability is "this channel's key is present in the table", never
//     "the request did not fail" (an absent table answers an empty 200, a 400
//     or a 500);
//   - configuration tables and the event `index` count channels from 0; the
//     snapshot URL counts from 1, except on old firmwares that answer
//     `snapshot.cgi?channel=0` (never asked of a doorbell);
//   - a recorder's cameras are its enabled, non-ONVIF RemoteDevice slots (an
//     ONVIF channel cannot be driven through the Dahua API). The slots hold
//     each camera's password in clear: the table is never logged nor kept;
//   - a person or a vehicle is reported by SmartMotionHuman / SmartMotionVehicle,
//     or by a line-crossing or intrusion rule whose object is a Human or a
//     Vehicle — many cameras only do the latter;
//   - a doorbell ring is BackKeyLight (Dahua VTO) or PhoneCallDetect (Amcrest)
//     with State 1 or 2; other states are the door, the call, idle.
// -----------------------------------------------------------------------------

export const KINDS = Object.freeze({
  CAMERA: 'camera',
  RECORDER: 'recorder',
  DOORBELL: 'doorbell',
});

// Detections a channel can report (feature keys, see src/devices.js).
export const DETECTIONS = Object.freeze({
  MOTION: 'motion',
  LINE_CROSSING: 'line_crossing',
  INTRUSION: 'intrusion',
  PERSON: 'person',
  VEHICLE: 'vehicle',
  AUDIO: 'audio',
  RING: 'ring',
});

// What reported a person (the `source` of the person_detected trigger).
export const SOURCES = Object.freeze({
  SMART_MOTION: 'smart_motion',
  LINE_CROSSING: 'line_crossing',
  INTRUSION: 'intrusion',
});

// Night vision modes (the `night_vision` feature values) ↔ Lighting Mode.
export const NIGHT_VISION = Object.freeze({ auto: 'Auto', on: 'Manual', off: 'Off' });

// Models whose siren rroller/dahua confirmed (its fallback list).
const SIREN_MODELS = [/AS-PV/i, /L46N/i, /^W452ASD/i, /TPC-BF1241/i];
const DOORBELL_MODELS = [/^(DHI?[-_])?VTO/i, /[-_]VTO/i, /^AD\d/i, /^DB6/i, /^DB2X/i, /^AV-V/i];
const RECORDER_CLASSES = ['NVR', 'DVR', 'XVR', 'HCVR'];

/** The kind of a device, from its class first, its model else. */
export function kindOf({ deviceClass, model }) {
  const cls = String(deviceClass ?? '').toUpperCase();
  const name = String(model ?? '');
  if (cls === 'VTO' || DOORBELL_MODELS.some((pattern) => pattern.test(name))) {
    return KINDS.DOORBELL;
  }
  if (RECORDER_CLASSES.includes(cls) || /NVR|DVR|XVR/i.test(name)) {
    return KINDS.RECORDER;
  }
  return KINDS.CAMERA;
}

/**
 * The channels of a recorder: its enabled, non-ONVIF RemoteDevice slots, else
 * every ChannelTitle entry (analog DVR channels have no RemoteDevice slot).
 * @param {Record<string, string>} remote RemoteDevice table (keys without `table.`)
 * @param {Record<string, string>} titles ChannelTitle table
 * @returns {number[]} 0-based indexes
 */
export function recorderChannels(remote, titles) {
  const slots = new Map();
  for (const [key, value] of Object.entries(remote)) {
    const match =
      key.match(/^RemoteDevice\.uuid:System_CONFIG_NETCAMERA_INFO_(\d+)\.(\w+)$/) ??
      key.match(/^RemoteDevice\[(\d+)\]\.(\w+)$/);
    if (!match) {
      continue;
    }
    const slot = slots.get(Number(match[1])) ?? {};
    slot[match[2]] = value;
    slots.set(Number(match[1]), slot);
  }
  const indexes = [...slots.entries()]
    .filter(([, slot]) => slot.Enable === 'true' && !/onvif/i.test(slot.ProtocolType ?? ''))
    .map(([index]) => index);
  if (indexes.length > 0) {
    return indexes.sort((a, b) => a - b);
  }
  return [...titleNames(titles).keys()].sort((a, b) => a - b).slice(0, 64);
}

/** `ChannelTitle[n].Name` as a map index → name. */
export function titleNames(titles) {
  const names = new Map();
  for (const [key, value] of Object.entries(titles)) {
    const match = key.match(/^ChannelTitle\[(\d+)\]\.Name$/);
    if (match) {
      names.set(Number(match[1]), value.trim());
    }
  }
  return names;
}

const has = (table, key) => Object.hasOwn(table, key);

/**
 * The IVS rules of a channel: `{ lineCrossing, intrusion }` when an enabled
 * rule of that type exists.
 */
export function ivsRules(rules, index) {
  const found = { lineCrossing: false, intrusion: false };
  const pattern = new RegExp(`^VideoAnalyseRule\\[${index}\\]\\[(\\d+)\\]\\.Type$`);
  for (const [key, type] of Object.entries(rules)) {
    const match = key.match(pattern);
    if (!match || rules[`VideoAnalyseRule[${index}][${match[1]}].Enable`] !== 'true') {
      continue;
    }
    if (type === 'CrossLineDetection') {
      found.lineCrossing = true;
    } else if (type === 'CrossRegionDetection') {
      found.intrusion = true;
    }
  }
  return found;
}

/** The row of the white light in Lighting_V2 for a channel, or null. */
export function whiteLightRow(lightingV2, index) {
  const pattern = new RegExp(`^Lighting_V2\\[${index}\\]\\[0\\]\\[(\\d+)\\]\\.LightType$`);
  for (const [key, type] of Object.entries(lightingV2)) {
    const match = key.match(pattern);
    if (
      match &&
      type === 'WhiteLight' &&
      has(lightingV2, `Lighting_V2[${index}][0][${match[1]}].Mode`)
    ) {
      return Number(match[1]);
    }
  }
  return null;
}

/** The lowest LeLensMask entry (the lens-covering privacy mode), or null. */
export function lensMaskEntry(lensMask) {
  const entries = Object.keys(lensMask)
    .map((key) => key.match(/^LeLensMask\[(\d+)\]\.Enable$/))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return entries.length > 0 ? Math.min(...entries) : null;
}

/**
 * The profile a channel lives in now (0 day, 1 night, 2 general), from
 * VideoInMode: the lighting of another profile is accepted and ignored.
 */
export function liveProfile(videoInMode, index) {
  const config = videoInMode[`VideoInMode[${index}].Config[0]`];
  if (config === '2') {
    return 2;
  }
  const extra = videoInMode[`VideoInMode[${index}].ConfigEx`];
  if (extra === 'Night') {
    return 1;
  }
  if (extra === 'Day') {
    return 0;
  }
  return ['0', '1', '2'].includes(config) ? Number(config) : 0;
}

/**
 * The capabilities of one channel, from the tables read once at start.
 * @param {object} tables { motion, smartMotion, rules, lighting, lightingV2, lensMask }
 * @param {number} index 0-based channel
 * @param {object} device { kind, model, coaxial: the siren status read, or null }
 */
export function channelCapabilities(tables, index, device) {
  const direct = device.kind !== KINDS.RECORDER;
  const ivs = ivsRules(tables.rules, index);
  const smart = has(tables.smartMotion, `SmartMotionDetect[${index}].Enable`);
  const motion = has(tables.motion, `MotionDetect[${index}].Enable`);
  const lensMask = direct ? lensMaskEntry(tables.lensMask) : null;
  return {
    motion: motion || device.kind === KINDS.DOORBELL,
    detectionSwitch: motion,
    lineCrossing: ivs.lineCrossing,
    intrusion: ivs.intrusion,
    person: smart || ivs.lineCrossing || ivs.intrusion,
    vehicle: (smart && device.kind !== KINDS.DOORBELL) || ivs.lineCrossing || ivs.intrusion,
    ring: device.kind === KINDS.DOORBELL,
    nightVision: has(tables.lighting, `Lighting[${index}][0].Mode`),
    whiteLight: whiteLightRow(tables.lightingV2, index),
    siren:
      device.kind === KINDS.CAMERA &&
      index === 0 &&
      (SIREN_MODELS.some((pattern) => pattern.test(device.model ?? '')) || Boolean(device.coaxial)),
    lensMask,
  };
}

// --- Events ----------------------------------------------------------------------

const RING_CODES = new Set(['BackKeyLight', 'PhoneCallDetect']);
const AUDIO_CODES = new Set(['AudioMutation', 'AudioAnomaly']);

/**
 * What an event means for a channel: a list of `{ detection, on, pulse }`
 * (`pulse`: on now, off a few seconds later), plus `rule` (the IVS rule name).
 * @param {{ code, action, index, data }} event
 * `source` says which detection reported a person or a vehicle.
 * @returns {{ channelIndex: number, effects: Array<{ detection, on, pulse }>,
 *   rule: string|null, source: string|null }}
 */
export function interpret(event) {
  const effects = [];
  const action = String(event.action).toLowerCase();
  const start = action === 'start';
  const stop = action === 'stop';
  const pulse = action === 'pulse';
  const data = event.data ?? {};
  // A doorbell reports BackKeyLight with index -1.
  const channelIndex = Math.max(0, Number.isFinite(event.index) ? event.index : 0);
  const switched = (detection) => {
    if (start || stop) {
      effects.push({ detection, on: start, pulse: false });
    } else if (pulse) {
      effects.push({ detection, on: true, pulse: true });
    }
  };
  let rule = null;
  let source = null;
  switch (event.code) {
    case 'VideoMotion':
      switched(DETECTIONS.MOTION);
      break;
    case 'SmartMotionHuman':
      switched(DETECTIONS.PERSON);
      source = SOURCES.SMART_MOTION;
      break;
    case 'SmartMotionVehicle':
      switched(DETECTIONS.VEHICLE);
      break;
    case 'CrossLineDetection':
    case 'CrossRegionDetection': {
      switched(
        event.code === 'CrossLineDetection' ? DETECTIONS.LINE_CROSSING : DETECTIONS.INTRUSION,
      );
      source = event.code === 'CrossLineDetection' ? SOURCES.LINE_CROSSING : SOURCES.INTRUSION;
      rule = typeof data.Name === 'string' && data.Name.trim() ? data.Name.trim() : null;
      const object = String(data.Object?.ObjectType ?? '').toLowerCase();
      if ((start || pulse) && object === 'human') {
        effects.push({ detection: DETECTIONS.PERSON, on: true, pulse: true });
      } else if ((start || pulse) && object === 'vehicle') {
        effects.push({ detection: DETECTIONS.VEHICLE, on: true, pulse: true });
      }
      break;
    }
    default:
      if (AUDIO_CODES.has(event.code)) {
        switched(DETECTIONS.AUDIO);
      } else if (RING_CODES.has(event.code)) {
        const state = Number(data.State ?? data.state);
        if (state === 1 || state === 2) {
          effects.push({ detection: DETECTIONS.RING, on: true, pulse: true });
        }
      }
  }
  return { channelIndex, effects, rule, source };
}
