# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Dahua cameras, recorders (NVR, XVR) and doorbells (VTO), and the brands
  built on Dahua that keep its API (Amcrest, Lorex…), over their local HTTP
  API with digest authentication: one Gladys device per camera, per recorder
  channel and per doorbell.
- Camera image, refreshed on a timer (every 5 minutes by default), at each
  person and ring, and on demand; resized to fit Gladys.
- Online, motion, line crossing, intrusion, person and vehicle, audio alarm
  and doorbell ring, followed live over the event stream of each device.
- Controls: motion detection, night vision (auto, on, off), floodlight,
  privacy mask, and the siren (only once allowed in the configuration).
- Scene triggers "Person detected by a camera" and "Someone rang the
  doorbell", with a fresh camera image before the scene starts.
- Scene actions "Refresh a camera image" and "Open the door of a doorbell"
  (disabled by default, never a switch).
- Dashboard widget "Dahua": cameras online, persons and rings of the last
  24 hours with their image.
- Configuration actions "Test the connection" and "Show the video stream
  address" (for the "RTSP camera" integration, never with the password).
- A password refused once is never tried again on its own, so a device does
  not lock the account.
- English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-dahua/commits/main
