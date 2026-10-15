// -----------------------------------------------------------------------------
// What the devices write: `key=value` answers, refusals hidden in a 200, and
// the multipart event stream with the shapes rroller/dahua met in the field
// (a part split across TCP chunks, a heartbeat without blank line, a wrong
// Content-Length, `\n` endings, a custom boundary, `;` and `=` inside the
// JSON, a cut JSON).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MultipartSplitter,
  boundaryOf,
  isAccepted,
  isRefusal,
  parseEvent,
  parseKeyValue,
} from '../src/dahua/parse.js';
import { EVENTS } from './helpers/fakeDahua.js';

test('key=value answers split on the first "="', () => {
  assert.deepEqual(
    parseKeyValue('version=2.800.0000016.0.R,build:2020-06-05\r\nx=a=b\r\n\r\nraw\n'),
    {
      version: '2.800.0000016.0.R,build:2020-06-05',
      x: 'a=b',
      raw: 'raw',
    },
  );
});

test('a 200 starting with Error is a refusal; OK or nothing is accepted', () => {
  for (const body of ['Error', 'Error\r\n', 'Error: No Events', 'error\r\nBad Request!']) {
    assert.equal(isRefusal(body), true, body);
  }
  assert.equal(isRefusal('OK\r\n'), false);
  assert.equal(isAccepted('OK\r\n'), true);
  assert.equal(isAccepted(''), true);
  assert.equal(isAccepted('ErrorCode=0'), false);
});

test('an event: code, action, index and its JSON data', () => {
  assert.deepEqual(parseEvent(EVENTS.motionStart), {
    code: 'VideoMotion',
    action: 'Start',
    index: 0,
    data: { Id: [0], RegionName: ['Region1'], SmartMotionEnable: true },
  });
  assert.equal(parseEvent(EVENTS.crossLineHuman).data.Object.ObjectType, 'Human');
  assert.equal(parseEvent(EVENTS.ring).index, -1);
  // A ";" inside the JSON stays in the JSON.
  assert.equal(parseEvent(EVENTS.ruleWithSemicolon).data.Name, 'Drive; Gate');
  // A cut payload keeps the event, without data.
  assert.deepEqual(parseEvent(EVENTS.crossLineTruncated), {
    code: 'CrossLineDetection',
    action: 'Start',
    index: 0,
    data: null,
  });
  assert.deepEqual(parseEvent('Code=SmartMotionHuman;action=Start;index=1'), {
    code: 'SmartMotionHuman',
    action: 'Start',
    index: 1,
    data: null,
  });
  assert.equal(parseEvent('Heartbeat'), null);
  // "=" in a base64 value of the JSON survives.
  assert.equal(parseEvent('Code=X;action=Pulse;index=0;data={"B":"YQ=="}').data.B, 'YQ==');
});

function split(chunks, boundary = '--myboundary') {
  const parts = [];
  const splitter = new MultipartSplitter(boundary, (part) => parts.push(part));
  for (const chunk of chunks) {
    splitter.push(Buffer.from(chunk));
  }
  return parts;
}

const part = (text) =>
  `--myboundary\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}\r\n`;

test('parts with a Content-Length, even split across chunks and boundaries', () => {
  const stream =
    part('Heartbeat') + part(EVENTS.motionStart) + part('Code=VideoMotion;action=Stop;index=0');
  assert.deepEqual(split([stream]), [
    'Heartbeat',
    EVENTS.motionStart,
    'Code=VideoMotion;action=Stop;index=0',
  ]);
  // One byte at a time: the boundary itself is cut.
  assert.deepEqual(split([...stream]), [
    'Heartbeat',
    EVENTS.motionStart,
    'Code=VideoMotion;action=Stop;index=0',
  ]);
});

test('a heartbeat without blank line, a part without Content-Length, \\n endings', () => {
  const stream =
    '--myboundary\r\nContent-Type: text/plain\r\nContent-Length:9\r\nHeartbeat\r\n' +
    '--myboundary\nContent-Type: text/plain\n\nCode=AudioMutation;action=Start;index=0\n' +
    '--myboundary\r\n';
  assert.deepEqual(split([stream]), ['Heartbeat', 'Code=AudioMutation;action=Start;index=0']);
});

test('a wrong Content-Length gives way to the next boundary', () => {
  const stream =
    '--myboundary\r\nContent-Type: text/plain\r\nContent-Length: 500\r\n\r\nCode=VideoMotion;action=Start;index=0\r\n' +
    part('Heartbeat');
  assert.deepEqual(split([stream]), ['Code=VideoMotion;action=Start;index=0', 'Heartbeat']);
});

test('the boundary of the content type, with or without quotes', () => {
  assert.equal(boundaryOf('multipart/x-mixed-replace; boundary=myboundary'), '--myboundary');
  assert.equal(boundaryOf('multipart/x-mixed-replace; boundary="abc123"'), '--abc123');
  assert.equal(boundaryOf(undefined), '--myboundary');
  const stream = '--abc123\r\nContent-Type: text/plain\r\n\r\nHeartbeat\r\n--abc123\r\n';
  assert.deepEqual(split([stream], '--abc123'), ['Heartbeat']);
});

test('garbage without boundary never grows the buffer without end', () => {
  const splitter = new MultipartSplitter('--myboundary', () => {});
  for (let i = 0; i < 100; i += 1) {
    splitter.push(Buffer.alloc(4096, 0x41));
  }
  assert.ok(splitter.buffer.length <= 132 * 1024);
});
