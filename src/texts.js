// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the reports of the Configuration actions, scene
// action errors. Four languages, the four of the Gladys interface; German
// says "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './dahua/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noHost: {
    en: 'Enter the address of your Dahua cameras, recorder or doorbell in the configuration.',
    fr: "Saisissez l'adresse de vos caméras, enregistreur ou portier Dahua dans la configuration.",
    de: 'Gib die Adresse deiner Dahua-Kameras, deines Rekorders oder deiner Türsprechanlage in der Konfiguration ein.',
    es: 'Introduzca la dirección de sus cámaras, grabador o portero Dahua en la configuración.',
  },
  invalidHost: {
    en: 'Address not understood, e.g. 192.168.1.108 (no password in the address).',
    fr: "Adresse incomprise, ex. 192.168.1.108 (pas de mot de passe dans l'adresse).",
    de: 'Adresse nicht verstanden, z. B. 192.168.1.108 (kein Passwort in der Adresse).',
    es: 'Dirección no válida, p. ej. 192.168.1.108 (sin contraseña en la dirección).',
  },
  noPassword: {
    en: 'Enter the password of your Dahua devices in the configuration.',
    fr: 'Saisissez le mot de passe de vos appareils Dahua dans la configuration.',
    de: 'Gib das Passwort deiner Dahua-Geräte in der Konfiguration ein.',
    es: 'Introduzca la contraseña de sus dispositivos Dahua en la configuración.',
  },
  someDown: {
    en: 'Connected, but some devices do not answer: see the integration logs.',
    fr: "Connectée, mais certains appareils ne répondent pas : voir les logs de l'intégration.",
    de: 'Verbunden, aber einige Geräte antworten nicht: Sieh dir die Protokolle der Integration an.',
    es: 'Conectada, pero algunos dispositivos no responden: consulte los registros de la integración.',
  },
  live: {
    en: 'Connected, but live events are interrupted: states are read every minute.',
    fr: 'Connectée, mais les événements en direct sont coupés : états relus chaque minute.',
    de: 'Verbunden, aber die Live-Ereignisse sind unterbrochen: Zustände jede Minute neu gelesen.',
    es: 'Conectada, pero los eventos en directo están cortados: estados leídos cada minuto.',
  },
};

// One explanation per error kind (src/dahua/client.js), shown in the
// connection status and in the reports.
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'The device does not answer: check its address and that Gladys can reach it.',
    fr: "L'appareil ne répond pas : vérifiez son adresse et que Gladys peut l'atteindre.",
    de: 'Das Gerät antwortet nicht: Prüfe seine Adresse und ob Gladys es erreicht.',
    es: 'El dispositivo no responde: compruebe su dirección y que Gladys pueda alcanzarlo.',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'User name or password refused: check them in the configuration.',
    fr: "Nom d'utilisateur ou mot de passe refusé : vérifiez-les dans la configuration.",
    de: 'Benutzername oder Passwort abgelehnt: Prüfe sie in der Konfiguration.',
    es: 'Nombre de usuario o contraseña rechazados: compruébelos en la configuración.',
  },
  [ERROR_KINDS.BLOCKED]: {
    en: 'Password refused: stopped so the device does not lock the account. Fix it, then test the connection.',
    fr: "Mot de passe refusé : arrêt pour que l'appareil ne bloque pas le compte. Corrigez-le, puis testez la connexion.",
    de: 'Passwort abgelehnt: angehalten, damit das Gerät das Konto nicht sperrt. Korrigiere es und teste die Verbindung.',
    es: 'Contraseña rechazada: detenido para que el dispositivo no bloquee la cuenta. Corríjala y pruebe la conexión.',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'This account is not allowed to do this: use an administrator account.',
    fr: "Ce compte n'a pas ce droit : utilisez un compte administrateur.",
    de: 'Dieses Konto darf das nicht: Verwende ein Administratorkonto.',
    es: 'Esta cuenta no tiene ese permiso: utilice una cuenta de administrador.',
  },
  [ERROR_KINDS.NO_API]: {
    en: 'No Dahua HTTP API at this address: check the address and that CGI is enabled on the device.',
    fr: "Pas d'API HTTP Dahua à cette adresse : vérifiez l'adresse et que le CGI est activé sur l'appareil.",
    de: 'Keine Dahua-HTTP-API unter dieser Adresse: Prüfe die Adresse und ob CGI auf dem Gerät aktiv ist.',
    es: 'No hay API HTTP Dahua en esta dirección: compruebe la dirección y que CGI esté activado.',
  },
  [ERROR_KINDS.REFUSED]: {
    en: 'The device refused the setting: it may not support it.',
    fr: "L'appareil a refusé le réglage : il ne le prend peut-être pas en charge.",
    de: 'Das Gerät hat die Einstellung abgelehnt: Es unterstützt sie vielleicht nicht.',
    es: 'El dispositivo rechazó el ajuste: puede que no lo admita.',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'The device refused the request: see the integration logs.',
    fr: "L'appareil a refusé la requête : voir les logs de l'intégration.",
    de: 'Das Gerät hat die Anfrage abgelehnt: Sieh dir die Protokolle der Integration an.',
    es: 'El dispositivo rechazó la solicitud: consulte los registros de la integración.',
  },
};

// Device kinds in the reports.
export const KIND_TEXT = {
  en: { camera: 'camera', recorder: 'recorder', doorbell: 'doorbell' },
  fr: { camera: 'caméra', recorder: 'enregistreur', doorbell: 'portier' },
  de: { camera: 'Kamera', recorder: 'Rekorder', doorbell: 'Türsprechanlage' },
  es: { camera: 'cámara', recorder: 'grabador', doorbell: 'portero' },
};

// Report of the "Test the connection" action, one line per device.
export const REPORT_TEXT = {
  en: {
    ok: (host, model, kind, channels) => `${host}: ${model} (${kind}), ${channels} channel(s).`,
    failed: (host, reason) => `${host}: ${reason}`,
  },
  fr: {
    ok: (host, model, kind, channels) => `${host} : ${model} (${kind}), ${channels} canal(aux).`,
    failed: (host, reason) => `${host} : ${reason}`,
  },
  de: {
    ok: (host, model, kind, channels) => `${host}: ${model} (${kind}), ${channels} Kanal/Kanäle.`,
    failed: (host, reason) => `${host}: ${reason}`,
  },
  es: {
    ok: (host, model, kind, channels) => `${host}: ${model} (${kind}), ${channels} canal(es).`,
    failed: (host, reason) => `${host}: ${reason}`,
  },
};

// Messages of the Configuration actions and errors of the scene actions.
export const ACTION_TEXT = {
  notConfigured: {
    en: 'Configure the address, user name and password of a device first.',
    fr: "Configurez d'abord l'adresse, le nom d'utilisateur et le mot de passe d'un appareil.",
    de: 'Konfiguriere zuerst Adresse, Benutzername und Passwort eines Geräts.',
    es: 'Configure primero la dirección, el nombre de usuario y la contraseña de un dispositivo.',
  },
  pickCamera: {
    en: 'Choose a camera added to Gladys.',
    fr: 'Choisissez une caméra ajoutée à Gladys.',
    de: 'Wähle eine Kamera, die zu Gladys hinzugefügt wurde.',
    es: 'Elija una cámara añadida a Gladys.',
  },
  unknownCamera: {
    en: 'This camera is not (or no longer) one of the configured Dahua devices.',
    fr: "Cette caméra n'est pas (ou plus) un des appareils Dahua configurés.",
    de: 'Diese Kamera gehört nicht (mehr) zu den konfigurierten Dahua-Geräten.',
    es: 'Esta cámara no es (o ya no es) uno de los dispositivos Dahua configurados.',
  },
  notDoorbell: {
    en: 'This device is not a doorbell: it has no door to open.',
    fr: "Cet appareil n'est pas un portier : il n'a pas de porte à ouvrir.",
    de: 'Dieses Gerät ist keine Türsprechanlage und hat keine Tür zum Öffnen.',
    es: 'Este dispositivo no es un portero: no tiene puerta que abrir.',
  },
  doorDisabled: {
    en: 'Opening the door is disabled: allow it in the configuration of the integration first.',
    fr: "L'ouverture de porte est désactivée : autorisez-la d'abord dans la configuration de l'intégration.",
    de: 'Das Öffnen der Tür ist deaktiviert: Erlaube es zuerst in der Konfiguration der Integration.',
    es: 'La apertura de la puerta está desactivada: autorícela primero en la configuración de la integración.',
  },
  snapshotFailed: {
    en: 'The device did not send an image of this camera.',
    fr: "L'appareil n'a pas envoyé d'image de cette caméra.",
    de: 'Das Gerät hat kein Bild dieser Kamera gesendet.',
    es: 'El dispositivo no envió ninguna imagen de esta cámara.',
  },
  stream: {
    en: 'For the "RTSP camera" integration of Gladys (replace PASSWORD):',
    fr: "Pour l'intégration « Caméra RTSP » de Gladys (remplacez PASSWORD) :",
    de: 'Für die Integration „RTSP-Kamera“ von Gladys (ersetze PASSWORD):',
    es: 'Para la integración «Cámara RTSP» de Gladys (sustituya PASSWORD):',
  },
};

// `object` variable of the person_detected trigger, by source.
export const SOURCE_NAMES = {
  en: { smart_motion: 'smart motion', line_crossing: 'line crossing', intrusion: 'intrusion' },
  fr: {
    smart_motion: 'détection intelligente',
    line_crossing: 'franchissement de ligne',
    intrusion: 'intrusion',
  },
  de: {
    smart_motion: 'intelligente Erkennung',
    line_crossing: 'Linienüberschreitung',
    intrusion: 'Eindringen',
  },
  es: {
    smart_motion: 'detección inteligente',
    line_crossing: 'cruce de línea',
    intrusion: 'intrusión',
  },
};

export const LANGUAGE_FALLBACK = 'en';

export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** A multi-language object built by a function of the language. */
export const localized = (render) =>
  Object.fromEntries(['en', 'fr', 'de', 'es'].map((language) => [language, render(language)]));
