// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
//   - refresh_snapshot: a fresh image of a camera, sent to Gladys, so the next
//     action ("send the camera image" in a message) sends what it sees now;
//   - open_door: open the door (strike, gate) of a Dahua doorbell. Disabled by
//     default: it only works once allowed in the configuration, it is never a
//     switch of a device (no voice assistant, no dashboard toggle can open it
//     by mistake), and the command is sent once, never retried.
// Gladys applies the field defaults to scene actions; a failure throws, the
// scene logs it and carries on.
// -----------------------------------------------------------------------------

// A doorbell drives one or two doors (lock modules).
export const DOORS = Object.freeze(['1', '2']);
export const DEFAULT_DOOR = '1';

export const SCENE_ACTIONS = {
  async refresh_snapshot(hub, { fields = {} }) {
    await hub.refreshSnapshot(fields.camera);
  },

  async open_door(hub, { fields = {} }) {
    const door = DOORS.includes(String(fields.door)) ? Number(fields.door) : Number(DEFAULT_DOOR);
    await hub.openDoor(fields.doorbell, door);
  },
};
