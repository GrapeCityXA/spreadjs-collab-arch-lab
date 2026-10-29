/**
 * A Node-side client for the lab's mirror protocol.
 *
 * The checks drive this exactly like a browser client drives the page: connect over
 * socket.io, send `m` frames in the official wire shape, apply snapshots and ops.
 * Keeping one client implementation here means the headless check and the browser
 * page exercise the same server semantics.
 */
import { io } from 'socket.io-client';
import { encodeMessage, decodeMessage } from '../server/mirror-codec.mjs';
import { sleep } from '../lab/ports.mjs';

let nextClientNumber = 1;

export class MirrorClient {
  /**
   * @param {{ url: string, path?: string, roomId: string, label?: string, timeoutMs?: number }} options
   */
  constructor({ url, path = '/collaboration/', roomId, label = 'check-client', timeoutMs = 6000 }) {
    this.url = url;
    this.path = path;
    this.roomId = roomId;
    this.label = label;
    this.clientId = `c${process.pid}-${nextClientNumber++}`;
    this.timeoutMs = timeoutMs;

    this.socket = null;
    this.nodeId = null;
    this.nodePort = null;
    this.version = 0;
    this.cells = new Map();
    this.seenOps = new Set();
    this.members = [];
    this.connectedAt = null;
    this.snapshotAt = null;

    this.#listeners = { op: [], snapshot: [], presence: [], nodeInfo: [], error: [], close: [] };
    this.#pendingAcks = new Map();
    this.#seq = 0;
  }

  #listeners;
  #pendingAcks;
  #seq;

  /**
   * Connect and capture the node identity pushed by the server.
   *
   * Retries a few times on purpose: a freshly started node answers `/health` a few
   * milliseconds before its socket.io endpoint accepts upgrades, and a check that
   * fails on that race teaches users the wrong lesson ("cross-node delivery is
   * flaky") instead of measuring the topology. Each attempt is a *new* socket, so a
   * half-open upgrade is thrown away rather than reused.
   */
  async connect() {
    const attempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.#connectOnce();
      } catch (err) {
        lastError = err;
        try {
          this.socket?.disconnect();
        } catch {
          /* half-open */
        }
        this.socket = null;
        if (attempt < attempts) await sleep(150 * attempt);
      }
    }
    throw lastError;
  }

  async #connectOnce() {
    this.socket = io(this.url, {
      path: this.path,
      transports: ['websocket'],
      query: { roomId: this.roomId, label: this.label, clientId: this.clientId },
      reconnection: false,
      forceNew: true,
      timeout: this.timeoutMs,
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连接 ${this.url} 超时`)), this.timeoutMs);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        this.connectedAt = Date.now();
        resolve();
      });
      this.socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(new Error(`连接 ${this.url} 失败: ${err?.message ?? err}`));
      });
    });

    this.socket.on('m', (frame) => {
      const [data, type] = decodeMessage(frame);
      this.#onFrame(data, type);
    });
    this.socket.on('disconnect', (reason) => this.#emit('close', reason));

    // The server pushes `sjs-node-info` on connect. Wait briefly so diagnostics can
    // report the node even before a snapshot arrives.
    await Promise.race([this.waitFor('nodeInfo', () => true, 1500).catch(() => null), sleep(50)]);
    return this;
  }

  #onFrame(data, type) {
    switch (type) {
      case 'sjs-node-info':
        this.nodeId = data?.nodeId ?? this.nodeId;
        this.nodePort = data?.port ?? this.nodePort;
        this.nodeInfo = data;
        this.#emit('nodeInfo', data);
        break;
      case 'lab:snapshot':
        this.nodeId = data?.nodeId ?? this.nodeId;
        this.version = Number(data?.version ?? 0);
        this.cells = new Map(Object.entries(data?.cells ?? {}));
        this.members = data?.members ?? [];
        this.snapshotAt = Date.now();
        this.#emit('snapshot', data);
        break;
      case 'lab:op': {
        if (data?.opId && this.seenOps.has(data.opId)) break;
        if (data?.opId) this.seenOps.add(data.opId);
        if (typeof data?.row === 'number' && typeof data?.col === 'number') {
          this.cells.set(`${data.row},${data.col}`, data.value);
        }
        this.version = Math.max(this.version, Number(data?.version ?? 0));
        this.#emit('op', { ...data, receivedAt: Date.now() });
        break;
      }
      case 'lab:op-ack': {
        const pending = this.#pendingAcks.get(data?.opId);
        if (pending) {
          this.#pendingAcks.delete(data.opId);
          pending.resolve({ ...data, latencyMs: Date.now() - pending.sentAt });
        }
        this.version = Math.max(this.version, Number(data?.version ?? 0));
        break;
      }
      case 'lab:presence':
        this.members = data?.members ?? this.members;
        this.#emit('presence', data);
        break;
      case 'lab:error':
        this.#emit('error', data);
        break;
      default:
        break;
    }
  }

  #emit(event, payload) {
    for (const fn of this.#listeners[event] ?? []) fn(payload);
    return payload;
  }

  /** Register a listener; returns an unsubscribe function. */
  on(event, fn) {
    (this.#listeners[event] ??= []).push(fn);
    return () => {
      this.#listeners[event] = (this.#listeners[event] ?? []).filter((f) => f !== fn);
    };
  }

  /** Resolve with the first payload that satisfies `predicate`. */
  waitFor(event, predicate = () => true, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const off = this.on(event, (payload) => {
        let hit = false;
        try {
          hit = Boolean(predicate(payload));
        } catch {
          hit = false;
        }
        if (hit) {
          clearTimeout(timer);
          off();
          resolve(payload);
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待 ${event} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
    });
  }

  #send(type, data) {
    if (!this.socket?.connected) throw new Error(`客户端 ${this.label} 未连接`);
    this.socket.emit('m', encodeMessage(data, type));
  }

  /** Join the room and resolve with the first snapshot. */
  async join(timeoutMs = this.timeoutMs) {
    const wait = this.waitFor('snapshot', () => true, timeoutMs);
    this.#send('lab:join', { label: this.label, roomId: this.roomId });
    return wait;
  }

  /** Force a fresh snapshot (used to model "a client reloads the document"). */
  async resync(timeoutMs = this.timeoutMs) {
    const wait = this.waitFor('snapshot', () => true, timeoutMs);
    this.#send('lab:resync', {});
    return wait;
  }

  /** Write a cell; resolves with the ack and the client-side round trip. */
  async setCell(row, col, value, timeoutMs = this.timeoutMs) {
    const opId = `${this.clientId}-${++this.#seq}`;
    const sentAt = Date.now();
    const ack = new Promise((resolve, reject) => {
      this.#pendingAcks.set(opId, { resolve, reject, sentAt });
      setTimeout(() => {
        if (this.#pendingAcks.delete(opId)) reject(new Error(`op ${opId} 未在 ${timeoutMs}ms 内收到 ack`));
      }, timeoutMs);
    });
    this.#send('lab:op', { opId, row, col, value, baseVersion: this.version, ts: sentAt });
    return ack;
  }

  getCell(row, col) {
    return this.cells.get(`${row},${col}`);
  }

  getCells() {
    return Object.fromEntries(this.cells);
  }

  close() {
    try {
      this.socket?.disconnect();
    } catch {
      /* already closed */
    }
  }
}

/** Connect + join in one step. */
export async function openClient(options) {
  const client = new MirrorClient(options);
  await client.connect();
  await client.join();
  return client;
}

/** Best-effort cleanup for a list of clients. */
export function closeAll(clients) {
  for (const client of clients ?? []) {
    try {
      client?.close();
    } catch {
      /* ignore */
    }
  }
}
