// -----------------------------------------------------------------------------
// Parsing what a Dahua device writes: the `key=value` lines of the CGI API,
// the refusals hidden in a 200, and the multipart event stream.
//
// Learned from rroller/dahua (MIT) and its tests: the event parts come with 1
// to 3 header lines, sometimes no blank line, `\n` or `\r\n` endings, a
// boundary split across TCP chunks, a Content-Length that may be wrong, and a
// JSON `data` that may hold `;` and `=` or be cut short.
// -----------------------------------------------------------------------------

/**
 * The lines of a CGI answer as an object, each line split on its first `=`.
 * @param {string|Buffer} body
 * @returns {Record<string, string>}
 */
export function parseKeyValue(body) {
  const result = {};
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const at = line.indexOf('=');
    if (at <= 0) {
      result[line] = line;
    } else {
      result[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  return result;
}

/**
 * Whether a 200 answer is in fact a refusal: its first line is `Error…`
 * (`Error`, `Error: No Events`, `Error: Error -1 getting param…`).
 */
export function isRefusal(body) {
  const first = String(body ?? '')
    .trimStart()
    .split(/\r?\n/)[0]
    .trim();
  return /^error\b/i.test(first);
}

/** Whether a write was accepted: an `OK` body (some firmwares send nothing). */
export function isAccepted(body) {
  const text = String(body ?? '').trim();
  return text === '' || /^ok\b/i.test(text);
}

// --- Events --------------------------------------------------------------------

const EVENT_HEAD = /^Code=([^;\r\n]+);action=([^;\r\n]+);index=(-?\d+)/i;

/**
 * One event block (`Code=…;action=…;index=…[;data={…}]`) as an object, or null.
 * The data is everything after the first `;data=`, read as JSON; a cut or
 * unreadable payload keeps the event with `data: null`.
 * @returns {{ code: string, action: string, index: number, data: object|null }|null}
 */
export function parseEvent(text) {
  const body = String(text ?? '');
  const start = body.search(/^Code=/im);
  if (start < 0) {
    return null;
  }
  const block = body.slice(start).trim();
  const head = block.match(EVENT_HEAD);
  if (!head) {
    return null;
  }
  let data = null;
  const at = block.indexOf(';data=');
  if (at >= 0) {
    try {
      const parsed = JSON.parse(block.slice(at + ';data='.length));
      data = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      data = null;
    }
  }
  return { code: head[1].trim(), action: head[2].trim(), index: Number(head[3]), data };
}

/** The boundary of a `multipart/x-mixed-replace; boundary=…` content type. */
export function boundaryOf(contentType) {
  const match = String(contentType ?? '').match(/boundary="?([^";]+)"?/i);
  const boundary = match ? match[1].trim() : 'myboundary';
  return boundary.startsWith('--') ? boundary : `--${boundary}`;
}

// A part never holds more than a few kilobytes; a stream that grows a buffer
// past this without a boundary is not sending parts.
const MAX_BUFFER = 128 * 1024;
const KEEP_ON_OVERFLOW = 4 * 1024;

/**
 * Cuts the event stream into parts. Feed it the bytes as they come; it calls
 * `onPart(text)` with the payload of each complete part (an event block or
 * `Heartbeat`).
 */
export class MultipartSplitter {
  constructor(boundary, onPart) {
    this.boundary = Buffer.from(boundary, 'latin1');
    this.onPart = onPart;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf(this.boundary);
      if (start < 0) {
        if (this.buffer.length > MAX_BUFFER) {
          this.buffer = this.buffer.subarray(this.buffer.length - KEEP_ON_OVERFLOW);
        }
        return;
      }
      if (start > 0) {
        this.buffer = this.buffer.subarray(start);
      }
      const next = this.buffer.indexOf(this.boundary, this.boundary.length);
      const part = this.cut(next);
      if (part === null) {
        if (this.buffer.length > MAX_BUFFER) {
          this.buffer = this.buffer.subarray(this.buffer.length - KEEP_ON_OVERFLOW);
        }
        return;
      }
      this.onPart(part);
    }
  }

  /**
   * The payload of the part at the head of the buffer, removed from it, or
   * null to wait for more bytes. `next` is the following boundary, or -1.
   */
  cut(next) {
    const limit = next < 0 ? this.buffer.length : next;
    const head = this.buffer.subarray(this.boundary.length, limit).toString('latin1');
    const blank = head.search(/\r?\n\r?\n/);
    if (blank < 0) {
      if (next < 0) {
        return null;
      }
      // No blank line (a heartbeat of some firmwares): the payload is what
      // follows the header lines, up to the next boundary.
      const text = this.buffer.subarray(this.boundary.length, next).toString('utf8');
      this.buffer = this.buffer.subarray(next);
      return payloadWithoutHeaders(text);
    }
    const headers = head.slice(0, blank);
    const separator = head.slice(blank).match(/^\r?\n\r?\n/)[0].length;
    const payloadStart =
      this.boundary.length + Buffer.byteLength(head.slice(0, blank), 'latin1') + separator;
    const length = Number(headers.match(/content-length:\s*(\d+)/i)?.[1]);
    if (Number.isFinite(length) && length > 0) {
      const end = payloadStart + length;
      if (next >= 0 && next < end) {
        // A wrong Content-Length: the next boundary wins.
        const text = this.buffer.subarray(payloadStart, next).toString('utf8');
        this.buffer = this.buffer.subarray(next);
        return text.trim();
      }
      if (this.buffer.length < end) {
        return null;
      }
      const text = this.buffer.subarray(payloadStart, end).toString('utf8');
      this.buffer = this.buffer.subarray(end);
      return text.trim();
    }
    if (next < 0) {
      return null;
    }
    const text = this.buffer.subarray(payloadStart, next).toString('utf8');
    this.buffer = this.buffer.subarray(next);
    return text.trim();
  }
}

/** A part without blank line: drop its `Name: value` header lines. */
function payloadWithoutHeaders(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^[A-Za-z-]+\s*:/.test(line))
    .join('\n')
    .trim();
}
