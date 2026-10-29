/**
 * Wire codec of the mirror protocol (DEV-CONTRACT §4).
 *
 * The collaboration protocol is exchanged on the socket.io event `m` with the
 * payload shape `[type, data, compressed]`, where `data` stays raw JSON below 128
 * serialized bytes and becomes gzip+base64 above it with `compressed === true`.
 *
 * This shape was extracted from `@grapecity-software/js-collaboration-client`
 * 19.2.1 rather than invented, which is what lets the mirror speak to the
 * *official* client as well as to raw socket.io clients. Reimplementing it from
 * the observed wire format is deliberate: the lab must not depend on the
 * commercial package for its zero-license path.
 */
import { gzipSync, gunzipSync } from 'node:zlib';

/** Socket.IO event name every collaboration frame travels on. */
export const SOCKET_IO_MESSAGE_EVENT = 'm';

/** Payloads whose serialized JSON stays below this size are sent uncompressed. */
export const COMPRESSION_THRESHOLD = 128;

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(text) {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/**
 * Encode one frame.
 *
 * @param {unknown} data
 * @param {string|null} type
 * @returns {[string|null, unknown, boolean]} `[type, data, compressed]`
 */
export function encodeMessage(data, type = null) {
  try {
    const json = JSON.stringify(data);
    const raw = new TextEncoder().encode(json);
    if (raw.byteLength < COMPRESSION_THRESHOLD) return [type, data, false];
    const gz = gzipSync(raw);
    // Only compress when it actually shrinks the frame; incompressible payloads
    // stay raw so the client never pays base64 inflation for nothing.
    if (gz.byteLength < raw.byteLength) return [type, toBase64(gz), true];
    return [type, data, false];
  } catch {
    // A value that cannot be serialized is not worth crashing a live room over.
    return [type, data, false];
  }
}

/**
 * Decode one frame. Telemetry and debugging payloads from other clients may be
 * malformed, so every failure path degrades to "pass the data through".
 *
 * @param {unknown} payload
 * @returns {[unknown, string|null]} `[data, type]`
 */
export function decodeMessage(payload) {
  if (!Array.isArray(payload) || payload.length < 2) return [payload, null];
  const [type, data, compressed] = payload;
  if (!compressed) return [data, type ?? null];
  try {
    if (typeof data !== 'string') return [data, type ?? null];
    const json = new TextDecoder().decode(gunzipSync(fromBase64(data)));
    return [JSON.parse(json), type ?? null];
  } catch {
    return [data, type ?? null];
  }
}
