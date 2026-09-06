// Shared helper for the DB-backed route suites (auth, follows). Wipes every
// table between tests so each case starts from a known-empty database. CASCADE
// covers the FK edges; RESTART IDENTITY is harmless (all ids are uuids).
export async function truncateAll(prisma) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FollowedTeam", "FollowedPlayer", "Notification", "Player", "Team", "User" RESTART IDENTITY CASCADE',
  );
}
