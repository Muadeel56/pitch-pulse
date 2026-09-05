// The seam between "whatever the cricket API sent" and "the shape the rest of
// the app already speaks" (id / teams / status / score / overs — see
// mockMatches.js). We parse the external body *loosely* — only the handful of
// fields we actually read, `z.looseObject` keeping the rest — then normalize
// *firmly* into the internal shape, turning every missing optional into `null`
// rather than letting `undefined` leak into a consumer.
//
// Deliberately not modelled on CricAPI specifically: we may end up on
// cricketdata.org, or on the mock generator forever. Parse for the lowest common
// denominator (`data` or `matches` list key, `score` innings array, started/ended
// booleans), normalize to one canonical result.
import { z } from 'zod';
import { ApiParseError } from '../errors.js';

const inningSchema = z.looseObject({
  inning: z.string().optional(),
  r: z.number().optional(),
  w: z.number().optional(),
  o: z.number().optional(),
});

const matchSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  matchType: z.string().optional(),
  teams: z.array(z.string()).optional(),
  matchStarted: z.boolean().optional(),
  matchEnded: z.boolean().optional(),
  score: z.array(inningSchema).optional(),
});

const infoSchema = z
  .looseObject({
    hitsToday: z.number().optional(),
    hitsLimit: z.number().optional(),
  })
  .optional();

// A list endpoint (`/currentMatches`): the matches live under `data` or
// `matches`; both absent is a valid (empty) response, but a non-array there is
// not.
export const externalMatchListSchema = z.looseObject({
  data: z.array(matchSchema).optional(),
  matches: z.array(matchSchema).optional(),
  info: infoSchema,
});

// A detail endpoint (`/match_info`): a single match object under `data`.
export const externalMatchDetailSchema = z.looseObject({
  data: matchSchema.optional(),
  info: infoSchema,
});

const KNOWN_STATUSES = new Set(['live', 'completed', 'upcoming']);

// Best-effort classification into the closed set the app uses. Boolean flags win
// (they're unambiguous); otherwise sniff the human-readable status string; else
// `unknown`.
function normalizeStatus(raw) {
  if (raw?.matchEnded === true) return 'completed';
  if (raw?.matchStarted === true) return 'live';

  const s = typeof raw?.status === 'string' ? raw.status.toLowerCase() : '';
  if (/live|in progress|innings break|rain delay/.test(s)) return 'live';
  if (/won|complete|result|abandon|no result|tie/.test(s)) return 'completed';
  if (/upcoming|scheduled|not started|starts|preview/.test(s)) return 'upcoming';
  if (KNOWN_STATUSES.has(s)) return s;
  return 'unknown';
}

// Pick the two team names, from an explicit `teams` array or by splitting a
// "<A> vs <B>" name. Always returns a 2-tuple; unknowns are `null`.
function normalizeTeams(raw) {
  if (Array.isArray(raw?.teams) && raw.teams.length >= 2) {
    return [raw.teams[0] ?? null, raw.teams[1] ?? null];
  }
  if (typeof raw?.name === 'string' && / vs | v /i.test(raw.name)) {
    const [a, b] = raw.name.split(/ vs | v /i);
    return [a?.trim() || null, b?.trim() || null];
  }
  return [null, null];
}

// `score` innings -> `{ [teamA]: "runs/wickets", [teamB]: "runs/wickets" }`.
// Innings are matched to a team by name prefix, falling back to position. No
// innings at all -> `null` (not `{}`).
function normalizeScore(raw, teams) {
  const innings = Array.isArray(raw?.score) ? raw.score : [];
  if (innings.length === 0) return null;

  const score = {};
  innings.forEach((inn, i) => {
    const byName = teams.find((t) => t && typeof inn?.inning === 'string' && inn.inning.startsWith(t));
    const team = byName ?? teams[i] ?? `Innings ${i + 1}`;
    const runs = typeof inn?.r === 'number' ? inn.r : 0;
    const wkts = typeof inn?.w === 'number' ? inn.w : 0;
    score[team] = `${runs}/${wkts}`;
  });
  return score;
}

// Highest overs figure seen across innings, as a number; `null` if none.
function normalizeOvers(raw) {
  const innings = Array.isArray(raw?.score) ? raw.score : [];
  const values = innings.map((inn) => inn?.o).filter((o) => typeof o === 'number');
  return values.length ? Math.max(...values) : null;
}

/**
 * Map one parsed external match onto the internal shape used everywhere else:
 * `{ id, teams: [a, b], status, score, overs }`.
 */
export function normalizeMatch(raw) {
  const teams = normalizeTeams(raw);
  return {
    id: raw?.id == null ? null : String(raw.id),
    teams,
    status: normalizeStatus(raw),
    score: normalizeScore(raw, teams),
    overs: normalizeOvers(raw),
  };
}

// Pull the raw match list out of either supported key.
export function extractMatchList(parsed) {
  if (Array.isArray(parsed?.data)) return parsed.data;
  if (Array.isArray(parsed?.matches)) return parsed.matches;
  return [];
}

/**
 * Run a body through one of the schemas above, converting every failure mode
 * into an `ApiParseError` carrying `flatten()`ed issues — so a surprising
 * payload never propagates as a `TypeError` from deep inside a consumer.
 */
export function parseOrThrow(schema, body, endpoint) {
  if (body == null) {
    throw new ApiParseError('Empty response body', {
      endpoint,
      issues: { formErrors: ['response body was null or undefined'], fieldErrors: {} },
    });
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    // e.g. a 200 with an HTML error page, or an array where an object belongs.
    throw new ApiParseError(`Expected a JSON object, got ${Array.isArray(body) ? 'array' : typeof body}`, {
      endpoint,
      issues: { formErrors: [`unexpected top-level type: ${Array.isArray(body) ? 'array' : typeof body}`], fieldErrors: {} },
    });
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiParseError('Response shape did not match schema', {
      endpoint,
      issues: result.error.flatten(),
    });
  }
  return result.data;
}
