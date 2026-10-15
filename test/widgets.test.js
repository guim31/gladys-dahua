// -----------------------------------------------------------------------------
// The `dahua` widget: within the core budget and vocabulary
// (validateWidgetContent), its images served, a camera chosen in its settings,
// and its messages when nothing is configured or a camera is gone.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { cameraIds, createAll, createWorld, doorbellIds, settle } from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

async function content(w, settings = {}, language = 'en') {
  const ack = await w.fake.widgetGet(WIDGET_KEY, { settings, language, units: 'metric' });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
}

test('every camera, the persons and rings with their images, within the budget', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.clock.advance(60_000);
  await w.emit('camera', 'crossLineHuman');
  await w.emit('doorbell', 'ring');
  const widget = await content(w);
  assert.deepEqual(validateWidgetContent(widget), []);
  const [online, events, list, status] = widget.components;
  assert.equal(online.value, '4/4');
  assert.equal(events.value, 2);
  assert.deepEqual(
    list.items.map((item) => item.title),
    ['Doorbell · Portier', 'Person · Entree'],
  );
  assert.ok(list.items.every((item) => item.image && item.date));
  assert.equal(status.items.length, 4);
  // The image of a list item is served.
  const image = await w.fake.widgetGetImage(list.items[0].image);
  assert.equal(image.success, true);
  assert.ok(Buffer.from(image.data.image, 'base64').length > 100);
  // The widget was nudged by the events.
  assert.ok(w.fake.widgetRefreshes.length > 0);
});

test('one camera chosen in the settings', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.clock.advance(60_000);
  await w.emit('camera', 'crossLineHuman');
  await w.emit('doorbell', 'ring');
  const widget = await content(w, { camera: doorbellIds(w.gladys).device }, 'fr');
  assert.deepEqual(validateWidgetContent(widget), []);
  assert.equal(widget.components[0].value, '1/1');
  assert.equal(widget.components[1].value, 1);
  assert.deepEqual(
    widget.components[2].items.map((item) => item.title),
    ['Sonnette · Portier'],
  );
});

test('an offline device shows in the tiles, the status and a caption', async (t) => {
  const w = await world(t);
  w.devices.camera.online = false;
  w.devices.camera.dropStreams();
  await settle();
  await w.hub.refresh();
  const widget = await content(w);
  assert.deepEqual(validateWidgetContent(widget), []);
  assert.equal(widget.components[0].type, 'text');
  assert.match(widget.components[0].text, /does not answer/);
  assert.equal(widget.components[1].value, '3/4');
  const status = widget.components.find((component) => component.type === 'status');
  assert.equal(status.items[0].value, 'Offline');
});

test('messages: nothing configured, a camera gone, nothing seen yet', async (t) => {
  const empty = await world(t, { config: {} });
  assert.match((await content(empty)).components[0].text, /Enter the address/);
  const w = await world(t);
  const gone = await content(w, { camera: 'ext:test-integration:camera:GONE' }, 'de');
  assert.match(gone.components[0].text, /nicht mehr konfiguriert/);
  const quiet = await content(w, { camera: cameraIds(w.gladys).device }, 'es');
  assert.deepEqual(validateWidgetContent(quiet), []);
  assert.ok(quiet.components.some((c) => c.type === 'text' && /Ninguna persona/.test(c.text)));
});
