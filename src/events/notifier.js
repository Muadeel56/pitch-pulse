import { EventEmitter } from 'node:events';

// Stub — real listeners (wicketFallen, milestoneReached, matchStarted) added in Phase 7.
// Exported as a singleton so the polling job and any listeners share one instance.
export const notifier = new EventEmitter();
