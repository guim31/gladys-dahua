# Dahua fixtures

Answers of the Dahua CGI API, as the devices write them (`key=value` lines,
`table.` prefix for configuration tables), one file per device of the test
world. The shapes and values come from rroller/dahua (MIT, "Copyright (c) 2020
Joakim Sørensen @ludeeus"): its code comments and tests quote the answers of
an IPC-HDW5831R-ZE camera, a DHI-NVR5464-16P-EI recorder and VTO2000A /
VTO2202F doorbells. Serial numbers, names and addresses are invented; no
answer of a real device of the author's network is here (the integration was
developed without the hardware).

- `camera.json`: a camera with smart motion detection, a line-crossing rule,
  infrared and white light (Lighting / Lighting_V2), lens masking, and a siren
  (AS-PV model, coaxialControlIO).
- `recorder.json`: a recorder with four RemoteDevice slots (two Dahua cameras,
  one ONVIF camera, one disabled), its channel titles, motion detection on
  every channel and smart motion on channel 2 only.
- `doorbell.json`: a VTO doorbell (class VTO, infrared Mode only).
- `events.json`: event blocks as the stream writes them (VideoMotion with
  data, CrossLineDetection with a Human object, SmartMotionHuman,
  AudioMutation, BackKeyLight states).
