// Minimal seed data so the follow endpoints (Issue #2) are testable
// end-to-end without manual DB surgery. Standalone script (own short-lived
// PrismaClient, disconnects at the end) rather than the app's long-running
// singleton in src/lib/prisma.js.
//
// Idempotent via check-then-create by `name` — Team/Player have no DB-level
// unique constraint on `name` (adding one is out of scope for this issue),
// so re-running this script skips rows that already exist instead of
// erroring or duplicating them.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const teams = [
  { name: 'India', shortName: 'IND' },
  { name: 'Australia', shortName: 'AUS' },
  { name: 'England', shortName: 'ENG' },
  { name: 'Pakistan', shortName: 'PAK' },
];

const players = [
  { name: 'Virat Kohli', team: 'India' },
  { name: 'Rohit Sharma', team: 'India' },
  { name: 'Pat Cummins', team: 'Australia' },
  { name: 'Steve Smith', team: 'Australia' },
  { name: 'Joe Root', team: 'England' },
  { name: 'Ben Stokes', team: 'England' },
  { name: 'Babar Azam', team: 'Pakistan' },
  { name: 'Shaheen Afridi', team: 'Pakistan' },
];

async function main() {
  const teamIdByName = {};

  for (const t of teams) {
    let team = await prisma.team.findFirst({ where: { name: t.name } });
    if (!team) {
      team = await prisma.team.create({ data: t });
      console.log(`Created team ${team.name} (${team.shortName}) — id: ${team.id}`);
    } else {
      console.log(`Team ${team.name} already exists — id: ${team.id}`);
    }
    teamIdByName[t.name] = team.id;
  }

  for (const p of players) {
    let player = await prisma.player.findFirst({ where: { name: p.name } });
    if (!player) {
      player = await prisma.player.create({ data: { name: p.name, teamId: teamIdByName[p.team] } });
      console.log(`Created player ${player.name} — id: ${player.id}`);
    } else {
      console.log(`Player ${player.name} already exists — id: ${player.id}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
