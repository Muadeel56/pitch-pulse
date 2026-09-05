// Isolated mock match data source for Phase 2. `src/lib/cricketApiClient.js`
// stays a stub until Phase 3, which will implement it against a real API (or
// the mock generator fallback, per the README) and swap it in here — routes
// only ever call getAllMatches()/getMatchById(), so that swap won't touch
// src/routes/matches.js at all.
//
// A fixed literal array (not randomized) keeps this deterministic and easy
// to curl-verify. IDs are small sequential strings, not UUIDs, since matches
// aren't modeled in Postgres and have no existing id convention to match.
function buildMatch(id, teamA, teamB, status) {
  const isPlayed = status !== 'upcoming';
  return {
    id: String(id),
    teams: [teamA, teamB],
    status,
    score: isPlayed
      ? { [teamA]: `${120 + id * 7}/${id % 10}`, [teamB]: `${100 + id * 5}/${(id + 3) % 10}` }
      : null,
    overs: isPlayed ? Number((10 + id * 1.3).toFixed(1)) : null,
  };
}

const matches = [
  buildMatch(1, 'India', 'Australia', 'live'),
  buildMatch(2, 'England', 'Pakistan', 'live'),
  buildMatch(3, 'South Africa', 'New Zealand', 'completed'),
  buildMatch(4, 'Sri Lanka', 'Bangladesh', 'upcoming'),
  buildMatch(5, 'India', 'England', 'upcoming'),
  buildMatch(6, 'Australia', 'South Africa', 'completed'),
];

export function getAllMatches() {
  return matches;
}

export function getMatchById(id) {
  return matches.find((m) => m.id === id) ?? null;
}
