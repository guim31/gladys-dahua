# Dahua

Brings Dahua **cameras**, **recorders** (NVR, XVR) and **doorbells** (VTO) into
Gladys, **locally**, through their HTTP API: camera images, motion, line
crossing and intrusion rules, persons and vehicles, audio alarms, doorbell
rings, and the controls of the cameras that have them (motion detection, night
vision, floodlight, siren, privacy mask). It also works with the brands built
on Dahua that keep its API, such as Amcrest and Lorex. No cloud account,
nothing leaves your network.

> **Developed without the hardware: feedback welcome.** This integration was
> written from the public Dahua HTTP API, the work of the Home Assistant
> `dahua` integration and real answers of devices, without a Dahua device at
> hand. If something does not work as described, please open an issue on
> [github.com/guim31/gladys-dahua/issues](https://github.com/guim31/gladys-dahua/issues)
> with the integration logs (`LOG_LEVEL=debug`).
>
> This integration is not affiliated with Dahua. Dahua, Amcrest and Lorex are
> trademarks of their owners.

## What you need

- A Dahua camera, recorder or doorbell (or a white-label model running the
  Dahua firmware) reachable from Gladys on your network, its web page working
  (port 80, or 443 in HTTPS).
- A **local account** of the device, ideally an administrator: an account
  without the rights can read but not change the settings. On recent
  firmwares, the authentication must accept **Digest MD5** (the default).
- Gladys **5.1 or later**.

Brands that moved to a cloud-only app (IMOU / Lechange models without a local
web page) cannot be used.

## Set up

### Settings

In Gladys, open the integration, then its **Configuration** tab:

- **Device addresses**: the IP addresses (or names) of your devices,
  separated by commas, with `:port` if it is not 80, and `https://` in front
  for HTTPS. For a recorder, its address is enough: each of its cameras
  becomes a device in Gladys. Never put a password in an address.
- **User name** and **Password**: the account of these devices (`admin` by
  default). The password is sent to the devices only, never to a cloud.
- **Other device addresses**, **Their user name**, **Their password**
  (optional): devices with other credentials, typically the doorbell.
- **Camera images**: how often the image of each camera added to Gladys is
  refreshed (every 5 minutes by default, or only on events). A person or a
  ring always sends a fresh one.
- **Control the sirens**: adds a **Siren** switch to the cameras that have
  one. Off by default.
- **Allow opening the door**: lets scenes open the door or gate wired to a
  Dahua doorbell. Off by default, see [Doorbells](#doorbells).
- **Language of the names**: the language of the feature names and of the
  texts sent to the scenes (French by default). Names are set when a device
  is added to Gladys.

Save: the status under the integration name turns to connected, and the
devices appear in the **Discover** tab. Add the ones you want.

**A wrong password is tried once.** A Dahua device locks the account for 5 to
30 minutes after a few refused passwords: at the first refusal, the
integration stops talking to that device (the others carry on) until you
change the configuration or click **Test the connection**.

### Configuration actions

- **Test the connection**: reads every device again and shows, for each one,
  its model, its kind and its number of channels, or why it does not answer.
  It also tries once more a password refused before.
- **Show the video stream address**: pick a camera, and the RTSP address of
  its video stream is shown under the button, ready for the "RTSP camera"
  integration of Gladys (see [Live video](#live-video)). The password is
  never shown: replace `PASSWORD` yourself.

## The devices

### Cameras

One device per camera, with the features its own settings show:

- **Image**: the camera image, refreshed at the chosen interval, at every
  person and ring, and on demand;
- **Online**: on while the device answers;
- **Motion**: on while the camera reports motion;
- **Line crossing**, **Intrusion**: on while a tripwire or intrusion rule
  (IVS) of the camera is triggered — only when an enabled rule exists;
- **Person**, **Vehicle**: on while the smart motion detection sees one, or
  for 10 seconds when a line crossing or intrusion rule reports a person or
  a vehicle;
- **Audio alarm**: on while the camera reports a sudden sound. It appears at
  the first audio alarm: click **Update** on the camera in the **Discover**
  tab;
- **Motion detection**: turns the motion detection of the camera on or off;
- **Night vision**: the infrared light, **Auto**, **On** or **Off**;
- **Floodlight**: the white light of the cameras that have one. Turning it on
  forces it on; turning it off gives it back to its previous mode;
- **Siren**: sounds the siren of the cameras that have one, only when
  **Control the sirens** is ticked. The siren stops by itself after 10 to
  15 seconds;
- **Privacy mask**: covers the lens (privacy mode). While it is on, the
  camera image is not refreshed by the timer.

A rule enabled after the device was added appears after a **Search** in the
**Discover** tab, then **Update**.

### Recorders

A recorder is not a device in Gladys: each of its Dahua cameras is, named as
in the recorder, with **Image**, **Online**, **Motion**, **Motion detection**,
and **Person** and **Vehicle** on the channels with smart motion detection.
Cameras added to the recorder in ONVIF cannot be driven through the Dahua API
and are left out. A recorder has one event stream for all its cameras.

### Doorbells

A Dahua doorbell (VTO) is a camera with **Doorbell ring**: it turns on for
10 seconds at each press of the button, and Gladys shows when it last rang.

**Opening the door is disabled by default** and is never a switch: no
dashboard toggle, no voice assistant can open it by mistake. Once **Allow
opening the door** is ticked, only the scene action **Open the door of a
doorbell** can do it, and the command is sent once, never retried.

## Dashboard

The **Dahua** widget shows at a glance:

- the cameras online (3/4) and the persons and rings of the last 24 hours;
- the last persons and rings, newest first, each with the image taken when
  it happened;
- the state of each camera.

In its settings, pick a camera to show only that one. The events are kept in
memory: the list starts empty after a restart of the integration.

## Scenes

### Triggers

- **Person detected by a camera**: a camera saw a person. Filters: the
  camera, and what detected it (smart motion detection, line crossing rule,
  intrusion rule); left empty, any matches. The actions can use the camera
  name, what detected the person and the name of the rule. One event per
  camera in 15 seconds: a person seen by two rules starts the scene once.
  When the scene starts, the image of the camera in Gladys is already the
  one of the detection.
- **Someone rang the doorbell**: the button of a doorbell was pressed.
  Filter: the doorbell. The actions can use its name. The doorbell image in
  Gladys is already the one of the ring.

The states of the devices (motion, line crossing, audio alarm…) are also
available to the usual "device state" trigger of Gladys.

### Actions

- **Refresh a camera image**: takes a fresh image of a camera for Gladys, so
  that the next action ("send a camera image" in a message) sends what the
  camera sees now.
- **Open the door of a doorbell**: opens door 1 or 2 of a doorbell. Refused
  unless **Allow opening the door** is ticked.

### Scene ideas

- **Someone rings**: trigger "Someone rang the doorbell", then "send a camera
  image" of the doorbell to your phone with the message "Someone at the
  door".
- **Person in the driveway at night**: trigger "Person detected by a camera"
  (camera Driveway), a condition on the time, then turn the garden lights on
  for 5 minutes.
- **Quiet when you are home**: when the house becomes occupied, turn
  **Motion detection** off on the indoor cameras; turn it back on when
  everybody leaves.
- **Night vision for the porch light**: when the porch light turns on, set
  **Night vision** of the entrance camera to **Off** (no reflection on the
  glass); back to **Auto** when it turns off.

## Live video

The **Image** feature shows still images. For live video, use the "RTSP
camera" integration of Gladys:

1. Run **Show the video stream address** with the camera.
2. Add the camera in the "RTSP camera" integration with this address, where
   you replace `PASSWORD` with the password of the device
   (`rtsp://admin:PASSWORD@<address>:554/cam/realmonitor?channel=1&subtype=0`;
   `subtype=1` gives the lighter sub-stream).

## Refresh and limits of the API

Gladys never polls these devices: the integration follows the event stream of
each device live, and reads the settings again every 5 minutes (every minute
while an event stream is down). The values are sent to Gladys only when they
change, and again every 6 hours when they do not.

The web server of a Dahua device is small: the integration sends at most two
requests at a time to each device, reads whole tables (a recorder costs the
same few requests as a camera), and waits 20 seconds at most for an answer.
Images: at most one every 6 seconds per camera (Gladys accepts 12 a minute).
Each request appears in the log of the device: a refresh every 5 minutes
keeps it readable.

## Troubleshooting

- **"The device does not answer"**: check the address, that the device is on,
  and that Gladys can reach it (same network, firewall).
- **"Password refused"**: correct the user name or password of that device,
  save, then click **Test the connection**. If the device locked the account,
  wait for it to unlock (5 to 30 minutes) or restart it.
- **"No Dahua HTTP API at this address"**: the address is not the one of the
  device, or the CGI API is disabled on it (on recent firmwares: Network,
  Port, or Security, "CGI").
- **"This account is not allowed"**: use an administrator account.
- **"The device refused the setting"**: this model or this channel does not
  support it; the feature stays as it was.
- **"live events are interrupted"**: the states still follow, every minute;
  persons and rings wait for the stream to come back. It reconnects by itself.
- **A rule, a light or a mask is missing**: enable it on the device, then
  **Search** in the **Discover** tab and **Update** the device.
- **No image**: the integration resizes images of up to 4K; a progressive
  JPEG larger than 1080p cannot be resized in the memory of the container.
  The logs say so once.
- For more detail, set `LOG_LEVEL=debug` on the integration and read its
  logs. They never contain a password.

## Limits

- Developed without the hardware: tested against real answers of the API and
  a simulated device, not against real devices.
- The doorbell ring is read from the HTTP event stream (`BackKeyLight`,
  `PhoneCallDetect`). Some doorbells report it only over their other protocol
  (DHIP, port 5000), not used yet: tell us if a ring does not show.
- Sirens are recognised on the models known to have one and on the cameras
  that report a speaker; the siren of the cameras behind a recorder is not
  driven.
- No PTZ control, no recording or alarm control, no two-way audio.
- Multi-sensor cameras: only their first channel is used.
- The list of events of the widget starts empty at each restart.
- Images are resized to 960 pixels wide at most (the limit of Gladys is
  150 KB per image).
