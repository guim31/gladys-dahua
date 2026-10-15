# Dahua for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for **Dahua**
cameras, recorders (NVR, XVR) and doorbells (VTO) — and the brands built on
Dahua that keep its API (Amcrest, Lorex…) — **locally**, through their HTTP API
with digest authentication. No cloud account, nothing leaves your network.

> **Developed without the hardware: feedback welcome.** No Dahua device was
> available to write this integration: it was built from the public Dahua HTTP
> API, the field knowledge of the Home Assistant
> [`dahua`](https://github.com/rroller/dahua) integration and the real answers
> its code and tests quote, and is covered by tests against a simulated device.
> Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-dahua/issues).

## Features

- **Cameras**: image (refreshed on a timer, at each person and ring, and on
  demand), online, motion, line crossing and intrusion (IVS rules), person and
  vehicle (smart motion detection, or a rule that reports a human or a
  vehicle), audio alarm — each one only when the camera has it.
- **Controls**: motion detection on/off, night vision (auto, on, off),
  floodlight (white light), privacy mask, and the siren of the cameras that
  have one (only once allowed in the configuration).
- **Recorders**: one Gladys device per Dahua camera of the recorder, named as
  in the recorder, one event stream for all of them.
- **Doorbells** (VTO): the ring, as the core `doorbell` feature (Gladys shows
  "Ringing" and the time of the last ring). Opening the door is **disabled by
  default**, never a switch: once allowed, a scene action only.
- **Scene triggers**: _Person detected by a camera_ (filter by camera and by
  what detected it) and _Someone rang the doorbell_. The camera image is
  refreshed in Gladys before the scene starts, so "send the camera image"
  sends the visitor.
- **Scene actions**: _Refresh a camera image_, _Open the door of a doorbell_
  (refused unless allowed).
- **Dashboard widget** _Dahua_: cameras online, persons and rings of the last
  24 hours with their image, the state of each camera.
- **Configuration actions**: _Test the connection_ (model, kind, channels of
  each device) and _Show the video stream address_ (the RTSP address of a
  camera for the "RTSP camera" integration of Gladys, never with the
  password).
- Four languages: English, French, German, Spanish.

## Requirements

- A Dahua device (or a white-label model with the Dahua firmware) with its
  local web page, reachable from Gladys, and a local account of it (an
  administrator to change settings). Digest MD5 authentication enabled (the
  default).
- Gladys Assistant **5.1.0 or later**.

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-dahua` (or
   install **Dahua** from the catalog once it is listed).
2. In **Configuration**, enter the addresses of your devices, the user name
   and the password (a second group for devices with other credentials, such
   as the doorbell), save, then click **Test the connection**.
3. Open the **Discover** tab and add the devices.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- **API**: the CGI API of the device, `GET /cgi-bin/…` answered in `key=value`
  lines: `magicBox.cgi` (identity), `configManager.cgi` (`getConfig` and
  `setConfig` of `MotionDetect`, `SmartMotionDetect`, `VideoAnalyseRule`,
  `Lighting`, `Lighting_V2`, `LeLensMask`, `VideoInMode`, `RemoteDevice`,
  `ChannelTitle`), `snapshot.cgi`, `coaxialControlIO.cgi` (siren),
  `accessControl.cgi` (door) and `eventManager.cgi?action=attach&codes=[All]`
  (events). HTTP digest (MD5, SHA-256), with node:http/https only: the event
  stream stays open for hours.
- **Passwords**: a device locks the account after a few refused passwords, so
  a password refused once is never tried again on its own: the device is left
  alone until the configuration changes or the user tests the connection.
- **Load**: at most two requests in flight per device (a dozen can wedge its
  web server), whole tables read at once, 20 s timeout.
- **Live**: one event stream per device, `codes=[All]` filtered locally,
  heartbeat every 5 s, reopened with a growing delay and recycled every hour.
  Devices are published with `should_poll: false`: the container reads the
  settings again every 5 minutes (every minute while a stream is down) —
  Gladys never polls (GladysAssistant/Gladys#3198).
- **States**: `publishChangedStates`, only the changes, plus a heartbeat every
  6 hours; only for the devices added to Gladys.
- **Capabilities**: judged on the keys a table holds for the channel, never on
  a request that did not fail; a detection the tables did not show (audio, a
  rule on a recorder) adds its feature at its first event.
- **Images**: Gladys takes 150 KB per camera image. A larger snapshot is
  decoded straight at 1/2, 1/4 or 1/8 by a small baseline JPEG decoder, then
  encoded again with [jpeg-js](https://github.com/eugeneware/jpeg-js) at
  960 pixels at most, in a worker thread (from
  [gladys-unifi-protect](https://github.com/guim31/gladys-unifi-protect)).
- **Persistence**: `/data/dahua-state.json` keeps what each device is (serial,
  model, channels, capabilities) and the detections learned, so a device off
  at start keeps its features. Nothing secret.
- **Logs**: the lifecycle only at info level; a repeated failure is logged
  once, and once when it clears; `LOG_LEVEL=debug` shows the rest. Never a
  password.

## What could not be checked

No Dahua device and no Gladys instance were available: the tests run against
the SDK's fake Gladys and simulated devices built from the answers quoted by
rroller/dahua (`test/fixtures/dahua/`). Not checked for real:

- the doorbell ring over the HTTP event stream (`BackKeyLight`,
  `PhoneCallDetect`): Home Assistant reads it over DHIP (TCP 5000) instead;
- the channel numbering of old firmwares (`snapshot.cgi?channel=0`), and
  analog channels of XVRs (taken from `ChannelTitle`);
- the siren detection on models outside rroller/dahua's list (a camera
  answering `coaxialControlIO` with a speaker is taken as having one);
- floodlights with `LightingScheme` (IPC-Color4M-TZ) and the dedicated
  floodlight cameras (`FloodLightMode`), not handled;
- `https://` addresses (self-signed certificates accepted).

A read-only probe is provided for a real device:
`DAHUA_PASSWORD=… node scripts/probe.mjs 192.168.1.108 [user]` prints the kind,
model, channels and capabilities, takes a snapshot and listens to the event
stream for 30 seconds, without printing the password, the serial number or the
cameras' credentials a recorder holds. It changes nothing on the device.

## Limitations

- No PTZ, no recording or alarm control, no two-way audio.
- Multi-sensor cameras: the first channel only.
- Doorbells over DHIP (TCP 5000) and devices without the CGI API (IMOU cloud
  models, SL300) are not supported.
- The widget's event list is kept in memory.
- Live video goes through the "RTSP camera" integration of Gladys.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and simulated Dahua devices (`test/helpers/fakeDahua.js`) that check the digest
authentication and stream events part by part. See [`CLAUDE.md`](CLAUDE.md)
for the project rules.

### Releasing

Describe each change under `## [Unreleased]` in
[`CHANGELOG.md`](CHANGELOG.md), then **Actions → Release → Run workflow**
(`patch`, `minor` or `major`): the workflow bumps the version everywhere, moves
the changelog section, tags, builds the multi-arch image to `ghcr.io` and
publishes the GitHub Release.

> A hand-pushed tag (`git tag v1.2.3 && git push --tags`) triggers the same
> build and Release, but does **not** bump anything: update `version` in
> `package.json` and in `gladys-assistant-integration.json` (with the
> `docker_image` tag) and commit it before tagging.

## Credits

- [rroller/dahua](https://github.com/rroller/dahua) (MIT, "Copyright (c) 2020
  Joakim Sørensen @ludeeus"), the Home Assistant integration for Dahua: the
  CGI endpoints, the answers its code and tests quote (fixtures adapted and
  anonymised), the event stream framing, the lockout and load lessons, the
  doorbell ring states, the lighting tables and the capability rules. No code
  was copied; the protocol knowledge was rewritten in JavaScript.
- [jpeg-js](https://github.com/eugeneware/jpeg-js) (BSD-3-Clause) encodes the
  resized images.
- The architecture, the image pipeline, the conformity tests and the quiet
  logs follow [gladys-unifi-protect](https://github.com/guim31/gladys-unifi-protect),
  [gladys-pihole](https://github.com/guim31/gladys-pihole) and
  [gladys-wled](https://github.com/guim31/gladys-wled); the digest
  authentication comes from [gladys-fritzbox](https://github.com/guim31/gladys-fritzbox).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Dahua Technology.
Dahua, Amcrest and Lorex are trademarks of their owners.

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
