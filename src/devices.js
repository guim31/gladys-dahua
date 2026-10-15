// -----------------------------------------------------------------------------
// The Gladys devices: one per video channel — a camera, a doorbell, or each
// camera of a recorder.
//
// Identity: the serial number the device reports (`getSystemInfo`), never an
// address or a name: `gladys.externalIds('camera', serial)` for a camera or a
// doorbell, `…('camera', '<serial>-ch<n>')` for channel n of a recorder.
// Feature keys are permanent once published (test/gladys-rules.test.js checks
// the couples against the core table).
//
// Features, each one only when the channel has it:
//   image          camera/image          snapshots
//   online         input/binary          the device answers (shown On/Off)
//   motion         motion-sensor/binary  VideoMotion start → stop
//   line_crossing  motion-sensor/binary  an IVS tripwire rule
//   intrusion      motion-sensor/binary  an IVS intrusion rule
//   person         motion-sensor/binary  smart motion or IVS object "Human"
//   vehicle        motion-sensor/binary  smart motion or IVS object "Vehicle"
//   audio          input/binary          audio alarm, learned at its first event
//   ring           doorbell/ring         1 → 0 pulse, as the core expects
//   detection      switch/binary         motion detection on/off
//   night_vision   text/select           infrared: auto, on, off
//   floodlight     light/binary          white light
//   siren          siren/binary          only when allowed in the configuration
//   privacy        switch/binary         lens masking (privacy mode)
// "Online" is input/binary: presence-sensor/binary would read "Presence
// detected" on a camera. Audio has no category of its own in Gladys: an
// input reads On/Off, where a motion sensor would say "Motion detected".
//
// The devices are published with should_poll: false: the integration follows
// the event stream and reads the devices on its own timer (src/hub.js),
// never waiting for Gladys to poll (GladysAssistant/Gladys#3198).
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { KINDS } from './dahua/model.js';

export const DEVICE_TYPE = 'camera';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  IMAGE: 'image',
  ONLINE: 'online',
  MOTION: 'motion',
  LINE_CROSSING: 'line_crossing',
  INTRUSION: 'intrusion',
  PERSON: 'person',
  VEHICLE: 'vehicle',
  AUDIO: 'audio',
  RING: 'ring',
  DETECTION: 'detection',
  NIGHT_VISION: 'night_vision',
  FLOODLIGHT: 'floodlight',
  SIREN: 'siren',
  PRIVACY: 'privacy',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    image: 'Image',
    online: 'Online',
    motion: 'Motion',
    line_crossing: 'Line crossing',
    intrusion: 'Intrusion',
    person: 'Person',
    vehicle: 'Vehicle',
    audio: 'Audio alarm',
    ring: 'Doorbell ring',
    detection: 'Motion detection',
    night_vision: 'Night vision',
    floodlight: 'Floodlight',
    siren: 'Siren',
    privacy: 'Privacy mask',
  },
  fr: {
    image: 'Image',
    online: 'En ligne',
    motion: 'Mouvement',
    line_crossing: 'Franchissement de ligne',
    intrusion: 'Intrusion',
    person: 'Personne',
    vehicle: 'Véhicule',
    audio: 'Alarme audio',
    ring: 'Sonnette',
    detection: 'Détection de mouvement',
    night_vision: 'Vision nocturne',
    floodlight: 'Projecteur',
    siren: 'Sirène',
    privacy: 'Masque de confidentialité',
  },
  de: {
    image: 'Bild',
    online: 'Online',
    motion: 'Bewegung',
    line_crossing: 'Linienüberschreitung',
    intrusion: 'Eindringen',
    person: 'Person',
    vehicle: 'Fahrzeug',
    audio: 'Audioalarm',
    ring: 'Türklingel',
    detection: 'Bewegungserkennung',
    night_vision: 'Nachtsicht',
    floodlight: 'Flutlicht',
    siren: 'Sirene',
    privacy: 'Privatsphäre-Maske',
  },
  es: {
    image: 'Imagen',
    online: 'En línea',
    motion: 'Movimiento',
    line_crossing: 'Cruce de línea',
    intrusion: 'Intrusión',
    person: 'Persona',
    vehicle: 'Vehículo',
    audio: 'Alarma de audio',
    ring: 'Timbre',
    detection: 'Detección de movimiento',
    night_vision: 'Visión nocturna',
    floodlight: 'Foco',
    siren: 'Sirena',
    privacy: 'Máscara de privacidad',
  },
};

// Options of night_vision (values permanent once published).
export const NIGHT_VISION_NAMES = {
  en: { auto: 'Auto', on: 'On', off: 'Off' },
  fr: { auto: 'Auto', on: 'Allumée', off: 'Éteinte' },
  de: { auto: 'Auto', on: 'An', off: 'Aus' },
  es: { auto: 'Auto', on: 'Encendida', off: 'Apagada' },
};

// Names of the devices Dahua did not name.
export const KIND_NAMES = {
  en: { camera: 'Dahua camera', doorbell: 'Dahua doorbell', recorder: 'Dahua recorder' },
  fr: { camera: 'Caméra Dahua', doorbell: 'Portier Dahua', recorder: 'Enregistreur Dahua' },
  de: { camera: 'Dahua-Kamera', doorbell: 'Dahua-Türsprechanlage', recorder: 'Dahua-Rekorder' },
  es: { camera: 'Cámara Dahua', doorbell: 'Portero Dahua', recorder: 'Grabador Dahua' },
};

const sensor = (category, type = DEVICE_FEATURE_TYPES.SENSOR.BINARY) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
});

const command = (category, type) => ({
  category,
  type,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  min: 0,
  max: 1,
});

const DEFINITIONS = {
  [FEATURE_KEYS.IMAGE]: {
    category: DEVICE_FEATURE_CATEGORIES.CAMERA,
    type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
    read_only: true,
    has_feedback: false,
    // Images travel on their own channel, never in the states history.
    keep_history: false,
    min: 0,
    max: 0,
  },
  [FEATURE_KEYS.ONLINE]: sensor(DEVICE_FEATURE_CATEGORIES.INPUT),
  [FEATURE_KEYS.MOTION]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.LINE_CROSSING]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.INTRUSION]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.PERSON]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.VEHICLE]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.AUDIO]: sensor(DEVICE_FEATURE_CATEGORIES.INPUT),
  [FEATURE_KEYS.RING]: sensor(
    DEVICE_FEATURE_CATEGORIES.DOORBELL,
    DEVICE_FEATURE_TYPES.DOORBELL.RING,
  ),
  [FEATURE_KEYS.DETECTION]: command(
    DEVICE_FEATURE_CATEGORIES.SWITCH,
    DEVICE_FEATURE_TYPES.SWITCH.BINARY,
  ),
  [FEATURE_KEYS.NIGHT_VISION]: {
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
    read_only: false,
    has_feedback: true,
    keep_history: true,
    // NOT NULL in Gladys even for a text feature.
    min: 0,
    max: 0,
  },
  [FEATURE_KEYS.FLOODLIGHT]: command(
    DEVICE_FEATURE_CATEGORIES.LIGHT,
    DEVICE_FEATURE_TYPES.LIGHT.BINARY,
  ),
  [FEATURE_KEYS.SIREN]: command(DEVICE_FEATURE_CATEGORIES.SIREN, DEVICE_FEATURE_TYPES.SIREN.BINARY),
  [FEATURE_KEYS.PRIVACY]: command(
    DEVICE_FEATURE_CATEGORIES.SWITCH,
    DEVICE_FEATURE_TYPES.SWITCH.BINARY,
  ),
};

/** The platform id of a channel: the serial, plus the channel on a recorder. */
export function platformId(channel) {
  const serial = String(channel.serial).replace(/[^A-Za-z0-9]/g, '');
  return channel.kind === KINDS.RECORDER ? `${serial}-ch${channel.index + 1}` : serial;
}

/** External ids of a channel and its features. */
export const channelIds = (gladys, channel) => gladys.externalIds(DEVICE_TYPE, platformId(channel));

// Default titles of a recorder channel, which say nothing.
const GENERIC_TITLE = /^(channel\s*\d*|ipc|cam(era)?\s*\d*|ch\s*\d+|\d+)$/i;

/** The name shown for a channel. */
export function channelName(channel, language = 'en') {
  const kinds = KIND_NAMES[language] ?? KIND_NAMES.en;
  if (channel.kind === KINDS.RECORDER) {
    const title = channel.title?.trim();
    if (title && !GENERIC_TITLE.test(title)) {
      return title;
    }
    return `${channel.deviceName || kinds.recorder} ${channel.index + 1}`;
  }
  return (
    channel.deviceName ||
    `${kinds[channel.kind] ?? kinds.camera} ${String(channel.serial).slice(-6)}`
  );
}

/**
 * The feature keys of a channel, in display order.
 * @param {object} channel { caps, learned: Set, kind }
 * @param {object} [options] { allowSiren }
 */
export function featureKeys(channel, { allowSiren = false } = {}) {
  const caps = channel.caps;
  const learned = channel.learned ?? new Set();
  const seen = (key) => learned.has(key);
  return [
    FEATURE_KEYS.IMAGE,
    FEATURE_KEYS.ONLINE,
    (caps.motion || seen(FEATURE_KEYS.MOTION)) && FEATURE_KEYS.MOTION,
    (caps.lineCrossing || seen(FEATURE_KEYS.LINE_CROSSING)) && FEATURE_KEYS.LINE_CROSSING,
    (caps.intrusion || seen(FEATURE_KEYS.INTRUSION)) && FEATURE_KEYS.INTRUSION,
    (caps.person || seen(FEATURE_KEYS.PERSON)) && FEATURE_KEYS.PERSON,
    (caps.vehicle || seen(FEATURE_KEYS.VEHICLE)) && FEATURE_KEYS.VEHICLE,
    seen(FEATURE_KEYS.AUDIO) && FEATURE_KEYS.AUDIO,
    (caps.ring || seen(FEATURE_KEYS.RING)) && FEATURE_KEYS.RING,
    caps.detectionSwitch && FEATURE_KEYS.DETECTION,
    caps.nightVision && FEATURE_KEYS.NIGHT_VISION,
    caps.whiteLight !== null && caps.whiteLight !== undefined && FEATURE_KEYS.FLOODLIGHT,
    caps.siren && allowSiren && FEATURE_KEYS.SIREN,
    caps.lensMask !== null && caps.lensMask !== undefined && FEATURE_KEYS.PRIVACY,
  ].filter(Boolean);
}

/**
 * The discovery payload of a channel.
 * @param {object} gladys SDK client
 * @param {object} channel see src/hub.js
 * @param {object} [options] { language, allowSiren }
 */
export function buildDevice(gladys, channel, { language = 'en', allowSiren = false } = {}) {
  const ids = channelIds(gladys, channel);
  const names = NAMES[language] ?? NAMES.en;
  const modes = NIGHT_VISION_NAMES[language] ?? NIGHT_VISION_NAMES.en;
  return {
    name: channelName(channel, language),
    external_id: ids.device,
    ...(channel.model ? { model: `Dahua ${channel.model}` } : {}),
    should_poll: false,
    params: [
      { name: 'host', value: channel.host },
      { name: 'channel', value: String(channel.index + 1) },
    ],
    features: featureKeys(channel, { allowSiren }).map((key) => ({
      ...DEFINITIONS[key],
      name: names[key],
      external_id: ids.feature(key),
      ...(key === FEATURE_KEYS.NIGHT_VISION
        ? {
            supported_options: Object.keys(modes).map((value, index) => ({
              value,
              label: modes[value],
              sort_order: index,
            })),
          }
        : {}),
    })),
  };
}

const flag = (value) => (value ? 1 : 0);
const optionalFlag = (value) => (value === null || value === undefined ? null : flag(value));

/**
 * The value of every feature of a channel (null: nothing to publish). Text
 * values are `{ text }`.
 * @param {object} channel see src/hub.js
 * @param {object} live { online, active: Set of detections, pulses: Set }
 */
export function featureValues(channel, live) {
  const on = (key) => live.active.has(key) || live.pulses.has(key);
  const settings = channel.settings ?? {};
  return {
    [FEATURE_KEYS.ONLINE]: flag(live.online),
    [FEATURE_KEYS.MOTION]: flag(on(FEATURE_KEYS.MOTION)),
    [FEATURE_KEYS.LINE_CROSSING]: flag(on(FEATURE_KEYS.LINE_CROSSING)),
    [FEATURE_KEYS.INTRUSION]: flag(on(FEATURE_KEYS.INTRUSION)),
    [FEATURE_KEYS.PERSON]: flag(on(FEATURE_KEYS.PERSON)),
    [FEATURE_KEYS.VEHICLE]: flag(on(FEATURE_KEYS.VEHICLE)),
    [FEATURE_KEYS.AUDIO]: flag(on(FEATURE_KEYS.AUDIO)),
    [FEATURE_KEYS.RING]: flag(on(FEATURE_KEYS.RING)),
    [FEATURE_KEYS.DETECTION]: optionalFlag(settings.detection),
    [FEATURE_KEYS.NIGHT_VISION]: settings.nightVision ? { text: settings.nightVision } : null,
    [FEATURE_KEYS.FLOODLIGHT]: optionalFlag(settings.floodlight),
    [FEATURE_KEYS.SIREN]: optionalFlag(settings.siren),
    [FEATURE_KEYS.PRIVACY]: optionalFlag(settings.privacy),
  };
}
