// Phase 6 — Real-time push.
//
// A Socket.io server rides on Fastify's underlying http.Server. Clients
// `join-match` to sit in a `match:{id}` room; when the Phase 4 poll job emits
// `matchUpdated` on the shared `notifier`, the changed matches are pushed as
// `scoreUpdate` events to exactly the rooms that care.
//
// TODO (issue #5 "out of scope"): authenticate the handshake (only logged-in
// users may join rooms), rate-limit `join-match`, tighten CORS off `*`, and add
// the Socket.io Redis adapter for multi-process broadcast (single process here).

import { Server } from 'socket.io';
import { notifier } from '../events/notifier.js';
import { logger } from '../utils/logger.js';

let io = null;
let matchUpdatedListener = null;

const MAX_MATCH_ID_LEN = 64;

const roomFor = (matchId) => `match:${matchId}`;

const normalizeMatchId = (raw) => {
  const id = String(raw ?? '').trim();
  if (!id || id.length > MAX_MATCH_ID_LEN) return null;
  return id;
};

/**
 * Attach Socket.io to an already-listening http.Server and wire the notifier
 * bridge. Idempotent — a second call returns the existing instance.
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
export function initSocket(httpServer) {
  if (io) return io;

  const origin = process.env.SOCKET_CORS_ORIGIN || '*';
  io = new Server(httpServer, { cors: { origin } });

  io.on('connection', (socket) => {
    logger.debug(`socket connected: ${socket.id}`);

    socket.on('join-match', (raw, ack) => {
      const matchId = normalizeMatchId(raw);
      if (!matchId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid matchId' });
        return;
      }
      socket.join(roomFor(matchId));
      const payload = { ok: true, matchId, room: roomFor(matchId) };
      if (typeof ack === 'function') ack(payload);
      // Also emit so a client that didn't pass an ack callback still sees it.
      socket.emit('joined', payload);
    });

    socket.on('leave-match', (raw) => {
      const matchId = normalizeMatchId(raw);
      if (matchId) socket.leave(roomFor(matchId));
    });

    // Socket.io removes a disconnected socket from all of its rooms
    // automatically — there is no hand-rolled room registry, so nothing to
    // clean up here. This is what satisfies "no memory leaks from dangling
    // room memberships".
    socket.on('disconnect', (reason) => {
      logger.debug(`socket disconnected: ${socket.id} (${reason})`);
    });
  });

  // Exactly one listener; the reference is kept so closeSocket can remove it.
  // Phase 7 will add more listeners on the same `notifier` — never
  // removeAllListeners() it.
  matchUpdatedListener = ({ polledAt, changes }) => {
    for (const change of changes ?? []) {
      try {
        // Per changed match, only to that match's room. A client viewing match 3
        // gets nothing when only match 7 changed. `io.to(room)` on an empty room
        // is a harmless no-op.
        io.to(roomFor(change.id)).emit('scoreUpdate', {
          id: change.id,
          type: change.type, // 'added' | 'removed' | 'changed'
          match: change.after, // full normalized match (null on 'removed')
          fields: change.fields, // which fields changed
          polledAt,
        });
      } catch (err) {
        logger.warn(`scoreUpdate broadcast failed for change ${change?.id}: ${err.message}`);
      }
    }
  };
  notifier.on('matchUpdated', matchUpdatedListener);

  return io;
}

/**
 * @returns {import('socket.io').Server}
 */
export function getIO() {
  if (!io) throw new Error('Socket.io not initialised — call initSocket() first');
  return io;
}

/**
 * Disconnect all sockets, stop the server, remove the notifier listener this
 * module added, and clear module state. Idempotent.
 * @returns {Promise<void>}
 */
export async function closeSocket() {
  if (matchUpdatedListener) {
    notifier.removeListener('matchUpdated', matchUpdatedListener);
    matchUpdatedListener = null;
  }
  if (io) {
    await io.close();
    io = null;
  }
}
