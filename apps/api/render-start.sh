#!/bin/sh
# Render's start command for the API.
#
# Render runs a service's start command without a shell, so `a && b` in
# `dockerCommand` is not two commands — it is one command whose name contains
# "&&", and the container exits 127 before anything runs. Anything with more
# than one step therefore belongs in a script like this one.
#
# Migrations run here rather than as a deploy hook because a pre-deploy command
# needs a paid instance type. `prisma migrate deploy` takes a Postgres advisory
# lock, so replicas starting together cannot race: the second waits, then finds
# nothing to apply. If a migration fails the service must not come up serving
# the old schema, hence `set -e`.
#
# Prisma is invoked through its binary rather than through pnpm: pnpm is a
# corepack shim in this image, and the runtime stage has never downloaded the
# package manager itself — asking for it at boot would mean a network fetch as
# an unprivileged user, on the one path where failing means no service at all.
set -e

cd /app
./apps/api/node_modules/.bin/prisma migrate deploy --schema apps/api/prisma/schema.prisma
exec node --enable-source-maps apps/api/dist/main.js
