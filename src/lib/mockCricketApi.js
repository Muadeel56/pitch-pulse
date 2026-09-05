// Mock cricket data provider — the default source whenever CRICKET_API_KEY is
// empty. It emits the *external* response shape a real API would (so every
// response, mock or HTTP, flows through the same parse/normalize path in
// cricketSchemas.js), seeded from the fixtures in mockMatches.js.
//
// Two things make it more than a static stub:
//   1. Live matches' scores and overs advance on a wall-clock basis, so Phase
//      4's snapshot diffing has real changes to detect.
//   2. Failure injection — a timeout, a 429 (with Retry-After), a 500, or a
//      malformed body can be forced on the next / every / every-Nth call, via
//      the CRICKET_MOCK_FAIL env var or __setMockFailure() in tests. This is how
//      the resilience layer is demoed without a real key (see the README's
//      "External API client" section).
import { getAllMatches } from './mockMatches.js';

// ~one score update every this-many milliseconds of wall-clock time.
const TICK_MS = 3000;

let state = null; // { matches: InternalMatch[], anchor: number }
let failure = null; // { kind, mode, n, counter }

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Tiny deterministic PRNG so a given (matchId, tick) always yields the same
// increment — the scores move over time but a test reading twice at the same
// instant sees the same thing.
function pseudoRandom(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000; // [0, 1)
}

function ensureState() {
  if (!state) state = { matches: getAllMatches().map(clone), anchor: Date.now() };
}

// Advance every live match by however many whole ticks have elapsed since the
// last evolution, then re-anchor. Zero elapsed ticks -> no change (keeps the
// happy-path test's deep-equal against mockMatches.js stable).
function evolve() {
  const elapsed = Date.now() - state.anchor;
  const ticks = Math.floor(elapsed / TICK_MS);
  if (ticks <= 0) return;
  state.anchor += ticks * TICK_MS;

  for (const match of state.matches) {
    if (match.status !== 'live' || !match.score) continue;
    for (const team of Object.keys(match.score)) {
      const [runs, wkts] = match.score[team].split('/').map(Number);
      let addedRuns = 0;
      let addedWkts = 0;
      for (let t = 0; t < ticks; t += 1) {
        const roll = pseudoRandom(`${match.id}:${team}:${t}:${state.anchor}`);
        addedRuns += 1 + Math.floor(roll * 6); // 1..6
        if (roll > 0.9) addedWkts += 1;
      }
      match.score[team] = `${runs + addedRuns}/${Math.min(10, wkts + addedWkts)}`;
    }
    match.overs = Number((match.overs + ticks * 0.3).toFixed(1));
  }
}

// InternalMatch { id, teams:[a,b], status, score, overs } -> the external
// per-match shape (matchStarted/matchEnded flags + a `score` innings array).
function toExternal(match) {
  const [a, b] = match.teams;
  const started = match.status === 'live' || match.status === 'completed';
  const ended = match.status === 'completed';
  const score = match.score
    ? Object.entries(match.score).map(([team, rw]) => {
        const [r, w] = rw.split('/').map(Number);
        return { inning: `${team} Inning 1`, r, w, o: match.overs };
      })
    : [];
  return {
    id: match.id,
    name: `${a} vs ${b}`,
    matchType: 't20',
    status: ended ? 'Match ended' : started ? 'Live' : 'Match not started',
    teams: [a, b],
    matchStarted: started,
    matchEnded: ended,
    score,
  };
}

function envelope(status, body, headers = {}) {
  return { status, headers, body };
}

// --- failure injection ------------------------------------------------------

// CRICKET_MOCK_FAIL syntax: "<kind>[:<mode>[:<n>]]", e.g. "500", "429:always",
// "timeout:once", "malformed:everyNth:3".
function failureFromEnv() {
  const raw = process.env.CRICKET_MOCK_FAIL;
  if (!raw) return null;
  const [kind, mode = 'always', n] = raw.split(':');
  return { kind, mode, n: n ? Number(n) : 2, counter: 0 };
}

function shouldTrigger() {
  if (!failure) return false;
  failure.counter += 1;
  if (failure.mode === 'once') return failure.counter === 1;
  if (failure.mode === 'everyNth') return failure.counter % (failure.n || 2) === 0;
  return true; // 'always'
}

function maybeFail() {
  if (!shouldTrigger()) return null;
  switch (failure.kind) {
    case 'timeout': {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'AbortError';
      err.retryable = true;
      throw err;
    }
    case '429':
      return envelope(429, { status: 'Failure', reason: 'Too many requests' }, { 'retry-after': '2' });
    case '500':
      return envelope(500, { status: 'Failure', reason: 'Internal error' });
    case 'malformed':
      // A 200 whose `data` is a string, not an array — trips the Zod schema.
      return envelope(200, { status: 'success', data: 'should-be-an-array', note: 'garbage' });
    default:
      return null;
  }
}

// --- provider contract ----------------------------------------------------

function currentMatchesBody() {
  ensureState();
  evolve();
  return {
    apikey: 'mock',
    data: state.matches.map(toExternal),
    info: { hitsToday: 1, hitsLimit: 100, offsetRows: 0, totalRows: state.matches.length },
  };
}

export function getCurrentMatches() {
  const forced = maybeFail();
  if (forced) return forced;
  return envelope(200, currentMatchesBody());
}

export function getMatchInfo(id) {
  const forced = maybeFail();
  if (forced) return forced;

  ensureState();
  evolve();
  const match = state.matches.find((m) => m.id === String(id));
  if (!match) {
    return envelope(404, { status: 'Failure', reason: `Match ${id} not found` });
  }
  return envelope(200, {
    apikey: 'mock',
    data: toExternal(match),
    info: { hitsToday: 1, hitsLimit: 100 },
  });
}

// --- test / dev hooks ---------------------------------------------------------

export function __setMockFailure(cfg) {
  failure = cfg ? { mode: 'always', n: 2, counter: 0, ...cfg } : null;
}

export function __resetMock() {
  state = null;
  failure = failureFromEnv();
}

// Pick up any env-configured failure at module load.
failure = failureFromEnv();
