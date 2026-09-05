// Exercises src/realtime/socket.js against a real Socket.io server instance
// (attached to a non-listening http.Server) without a network client: the
// per-connection handlers are driven with fake sockets, and the notifier→room
// bridge is asserted by spying on io.to(). This keeps the suite fast and free of
// a socket.io-client dependency (the issue permits "Socket.io's own test
// harness" as an alternative). Socket.io's own automatic room cleanup on a real
// disconnect is its behaviour, not ours — our code deliberately has no room
// registry to leak (see the comment in socket.js).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

import { initSocket, getIO, closeSocket } from '../socket.js';
import { notifier } from '../../events/notifier.js';
import { logger } from '../../utils/logger.js';

const match3 = { id: '3', teams: ['A', 'B'], status: 'live', score: { A: '61/2' }, overs: 12 };

function makeFakeSocket(id = `sock-${Math.random().toString(36).slice(2)}`) {
  const handlers = new Map();
  return {
    id,
    rooms: new Set(),
    outbound: [],
    on(ev, fn) {
      handlers.set(ev, fn);
    },
    trigger(ev, ...args) {
      return handlers.get(ev)?.(...args);
    },
    join(room) {
      this.rooms.add(room);
    },
    leave(room) {
      this.rooms.delete(room);
    },
    emit(ev, payload) {
      this.outbound.push({ ev, payload });
    },
  };
}

let httpServer;
let io;
let baseListenerCount;

// The connection handler our module registered on the main namespace.
const connectionHandler = () => io.sockets.listeners('connection')[0];

beforeEach(() => {
  baseListenerCount = notifier.listenerCount('matchUpdated');
  httpServer = http.createServer();
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  io = initSocket(httpServer);
});

afterEach(async () => {
  await closeSocket();
  vi.restoreAllMocks();
});

describe('initSocket / getIO', () => {
  it('is idempotent and getIO returns the live instance', () => {
    expect(initSocket(httpServer)).toBe(io);
    expect(getIO()).toBe(io);
  });

  it('registers exactly one matchUpdated listener', () => {
    expect(notifier.listenerCount('matchUpdated')).toBe(baseListenerCount + 1);
  });
});

describe('join-match / leave-match', () => {
  it('joins match:{id}, acks, and emits a joined confirmation', () => {
    const socket = makeFakeSocket();
    connectionHandler()(socket);
    const ack = vi.fn();

    socket.trigger('join-match', '3', ack);

    expect(socket.rooms.has('match:3')).toBe(true);
    expect(ack).toHaveBeenCalledWith({ ok: true, matchId: '3', room: 'match:3' });
    expect(socket.outbound).toContainEqual({
      ev: 'joined',
      payload: { ok: true, matchId: '3', room: 'match:3' },
    });
  });

  it('rejects an empty or absurdly long match id without joining', () => {
    const socket = makeFakeSocket();
    connectionHandler()(socket);
    const ack = vi.fn();

    socket.trigger('join-match', '   ', ack);
    socket.trigger('join-match', 'x'.repeat(200), ack);

    expect(socket.rooms.size).toBe(0);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenLastCalledWith({ ok: false, error: 'invalid matchId' });
  });

  it('leave-match removes the room', () => {
    const socket = makeFakeSocket();
    connectionHandler()(socket);
    socket.trigger('join-match', '3');

    socket.trigger('leave-match', '3');

    expect(socket.rooms.has('match:3')).toBe(false);
  });

  it('disconnect handler only logs — no manual room bookkeeping', () => {
    const socket = makeFakeSocket();
    connectionHandler()(socket);
    socket.trigger('join-match', '3');

    expect(() => socket.trigger('disconnect', 'transport close')).not.toThrow();
    // our handler touches nothing; Socket.io clears rooms on a real disconnect.
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/disconnected/));
  });
});

describe('notifier → room broadcast', () => {
  it('emits one scoreUpdate per changed match, only to that match room', () => {
    const emit = vi.fn();
    const toSpy = vi.spyOn(io, 'to').mockReturnValue({ emit });
    const polledAt = new Date().toISOString();

    notifier.emit('matchUpdated', {
      polledAt,
      matches: [match3],
      changes: [{ id: '3', type: 'changed', before: {}, after: match3, fields: ['score'] }],
    });

    expect(toSpy).toHaveBeenCalledTimes(1);
    expect(toSpy).toHaveBeenCalledWith('match:3');
    expect(toSpy).not.toHaveBeenCalledWith('match:9');
    expect(emit).toHaveBeenCalledWith('scoreUpdate', {
      id: '3',
      type: 'changed',
      match: match3,
      fields: ['score'],
      polledAt,
    });
  });

  it('a malformed change is logged and skipped; the listener survives for later changes', () => {
    const emit = vi.fn();
    const toSpy = vi.spyOn(io, 'to').mockReturnValue({ emit });

    notifier.emit('matchUpdated', {
      polledAt: 'now',
      changes: [null, { id: '3', type: 'changed', after: match3, fields: ['score'] }],
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/broadcast failed/));
    expect(toSpy).toHaveBeenCalledWith('match:3');
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('closeSocket', () => {
  it('removes the matchUpdated listener and is idempotent; getIO then throws', async () => {
    await closeSocket();
    expect(notifier.listenerCount('matchUpdated')).toBe(baseListenerCount);
    await expect(closeSocket()).resolves.toBeUndefined(); // second call is a no-op
    expect(() => getIO()).toThrow(/not initialised/);
  });
});
