// -----------------------------------------------------------------------------
// The HTTP seam of the Dahua client: one request over node:http or node:https,
// answered either as a whole body (CGI answers, snapshots) or as a stream (the
// event stream, which never ends). The tests replace it with the fake device
// (test/helpers/fakeDahua.js), which speaks the same shape.
//
// node:http rather than fetch: the event stream stays open for hours, and a
// device served over HTTPS has a self-signed certificate that fetch cannot be
// told to accept without a dependency.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';

// A snapshot of an 8 MP camera is a few hundred kilobytes; anything far
// larger is not an answer of the CGI API.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
  }
}

/**
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {number} [options.timeoutMs] idle timeout of the socket
 * @param {boolean} [options.stream] resolve as soon as the headers arrive
 * @returns {Promise<{ status: number, headers: object, body?: Buffer,
 *   stream?: AsyncIterable<Buffer>, close?: () => void }>}
 */
export function request(url, { method = 'GET', headers = {}, timeoutMs = 10_000, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const req = (secure ? https : http).request(target, {
      method,
      headers: { Connection: 'close', ...headers },
      // Dahua devices only ever present a self-signed certificate.
      ...(secure ? { rejectUnauthorized: false } : {}),
    });
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err instanceof HttpError ? err : new HttpError(err.message, err.code));
      }
    };
    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(`No answer within ${Math.round(timeoutMs / 1000)} s`, 'ETIMEDOUT'));
    });
    req.on('error', fail);
    req.on('response', (res) => {
      if (stream) {
        settled = true;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          stream: res,
          close: () => req.destroy(),
        });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new HttpError('Answer too large', 'EFBIG'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        }
      });
    });
    req.end();
  });
}
