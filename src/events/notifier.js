import { EventEmitter } from 'node:events';

// A single shared EventEmitter. The polling job (src/jobs/pollScores.js) emits
// into it; listeners live elsewhere and never here — that keeps this module
// dependency-free and avoids an import cycle with Prisma.
//
//   'matchUpdated'  — every real diff (src/realtime/socket.js bridges it to WS rooms)
//   'wicketFallen' / 'milestoneReached' / 'matchStarted'
//                   — semantic events; src/events/notificationHandlers.js persists them
//
// socket.js + notificationHandlers + the test suites all subscribe, so lift the
// default 10-listener warning ceiling.
export const notifier = new EventEmitter();
notifier.setMaxListeners(20);
