// Phase 7 — the reactive half of event-driven notifications.
//
// Listens on the shared `notifier` for the semantic events the poll job derives
// (wicketFallen / milestoneReached / matchStarted) and, for each, persists one
// Notification row per user who follows the relevant team. It knows nothing
// about polling, Redis, or WebSockets — it only reacts to events. Imports from
// src/realtime/ or src/cache/ here would break that decoupling on purpose.
//
// Lifecycle mirrors src/realtime/socket.js: an init/close pair that keeps
// explicit listener references, attaches exactly one listener per event, and
// never calls notifier.removeAllListeners() — socket.js shares this emitter.
//
// Known limitations (see also the Notification model + deriveMatchEvents):
//   - Team name ↔ id is a plain string match against seeded Team.name. An event
//     for a team that isn't seeded silently produces no notifications.
//   - No player-level events — the normalized match shape has no per-batter
//     data, so `playerId` is never set.

import { prisma } from '../lib/prisma.js';
import { notifier } from './notifier.js';
import { logger } from '../utils/logger.js';

// ── Module state (one set of listeners per process) ─────────────────────────
let listeners = null; // { wicketFallen, milestoneReached, matchStarted } fn refs

// Read env at init time (mirrors readPollConfig() in pollScores.js): default on,
// disabled only by the literal string 'false'.
function notificationsEnabled() {
  return (process.env.NOTIFICATIONS_ENABLED ?? 'true') !== 'false';
}

/**
 * Resolve a team name to a seeded Team.id, or null when it isn't seeded.
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function resolveTeamId(name) {
  if (!name) return null;
  const team = await prisma.team.findFirst({ where: { name }, select: { id: true } });
  return team?.id ?? null;
}

/**
 * Persist one Notification per follower of `teamId`. No-op when nobody follows.
 * @returns {Promise<number>} rows created
 */
async function notifyTeamFollowers({ teamId, userIds, type, message, matchId }) {
  const followers =
    userIds ??
    (await prisma.followedTeam.findMany({ where: { teamId }, select: { userId: true } })).map(
      (f) => f.userId,
    );
  if (followers.length === 0) return 0;

  const { count } = await prisma.notification.createMany({
    data: followers.map((userId) => ({ userId, type, message, matchId, teamId })),
  });
  return count;
}

// A listener throwing runs on the same tick as notifier.emit inside the poll
// job — so every handler body is wrapped: a DB blip logs a warning and is
// swallowed, never crashing the poll worker or the process.
function guard(name, fn) {
  return (payload) => {
    Promise.resolve()
      .then(() => fn(payload))
      .catch((err) => logger.warn(`notification handler '${name}' failed: ${err.message}`));
  };
}

async function onWicketFallen({ matchId, teamName, wickets }) {
  const teamId = await resolveTeamId(teamName);
  if (!teamId) {
    logger.debug(`wicketFallen: team '${teamName}' not seeded — skipping`);
    return;
  }
  const n = await notifyTeamFollowers({
    teamId,
    type: 'wicketFallen',
    message: `Wicket! ${teamName} are ${wickets} down`,
    matchId,
  });
  if (n) logger.debug(`wicketFallen: ${n} notification(s) for match ${matchId} (${teamName})`);
}

async function onMilestoneReached({ matchId, teamName, milestone }) {
  const teamId = await resolveTeamId(teamName);
  if (!teamId) {
    logger.debug(`milestoneReached: team '${teamName}' not seeded — skipping`);
    return;
  }
  const n = await notifyTeamFollowers({
    teamId,
    type: 'milestoneReached',
    message: `${teamName} reached ${milestone}`,
    matchId,
  });
  if (n) logger.debug(`milestoneReached: ${n} notification(s) for match ${matchId} (${teamName})`);
}

async function onMatchStarted({ matchId, teams }) {
  const [teamA, teamB] = teams ?? [];
  const [idA, idB] = await Promise.all([resolveTeamId(teamA), resolveTeamId(teamB)]);
  if (!idA && !idB) {
    logger.debug(`matchStarted: neither team seeded (${teamA} vs ${teamB}) — skipping`);
    return;
  }

  // One notification per follower of *either* team. A user following both gets a
  // single row; the team they follow first wins as its `teamId`.
  const teamIdByUser = new Map();
  for (const teamId of [idA, idB]) {
    if (!teamId) continue;
    const rows = await prisma.followedTeam.findMany({ where: { teamId }, select: { userId: true } });
    for (const { userId } of rows) {
      if (!teamIdByUser.has(userId)) teamIdByUser.set(userId, teamId);
    }
  }
  if (teamIdByUser.size === 0) return;

  const message = `Match started: ${teamA} vs ${teamB}`;
  const { count } = await prisma.notification.createMany({
    data: [...teamIdByUser].map(([userId, teamId]) => ({
      userId,
      type: 'matchStarted',
      message,
      matchId,
      teamId,
    })),
  });
  logger.debug(`matchStarted: ${count} notification(s) for match ${matchId}`);
}

/**
 * Attach the three semantic-event listeners. Idempotent — a second call is a
 * no-op. Gated by NOTIFICATIONS_ENABLED (default true), read here.
 */
export function initNotificationHandlers() {
  if (listeners) return;
  if (!notificationsEnabled()) {
    logger.info('notification handlers disabled (NOTIFICATIONS_ENABLED=false)');
    return;
  }

  listeners = {
    wicketFallen: guard('wicketFallen', onWicketFallen),
    milestoneReached: guard('milestoneReached', onMilestoneReached),
    matchStarted: guard('matchStarted', onMatchStarted),
  };
  for (const [event, fn] of Object.entries(listeners)) notifier.on(event, fn);
}

/**
 * Remove exactly the listeners initNotificationHandlers added, and clear state.
 * Idempotent. Used by graceful shutdown and the test suite.
 */
export function closeNotificationHandlers() {
  if (!listeners) return;
  for (const [event, fn] of Object.entries(listeners)) notifier.removeListener(event, fn);
  listeners = null;
}
