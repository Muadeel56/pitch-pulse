#!/bin/sh
set -e

# `migrate deploy` is idempotent — running it on every container start is the
# documented Prisma pattern, no "is this the first boot?" guard needed.
echo "Running prisma migrate deploy..."
npx prisma migrate deploy

# Seeding is opt-in so a restart never re-seeds. Set RUN_DB_SEED=true for the
# first boot, or run `docker compose exec app npx prisma db seed` by hand.
if [ "$RUN_DB_SEED" = "true" ]; then
  echo "Seeding database..."
  npx prisma db seed || echo "seed failed (non-fatal)"
fi

exec "$@"
