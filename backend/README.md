# OpenCom Backend

The backend workspace contains the shared services that power the OpenCom platform.

## Packages

- `packages/shared`: shared utilities and types
- `packages/core`: platform API for auth, profiles, social features, invites, presence, and platform services
- `packages/server-node`: guild, channel, message, attachment, moderation, and voice APIs
- `packages/media`: media-related backend services

## Requirements

- Node.js 22+
- npm
- MariaDB and Redis for local development

The easiest local path is to use the repo-level setup scripts from the project root.

## Common commands

From `backend/`:

```bash
npm install
npm run build
npm run dev:core
npm run dev:node
npm run dev:media
npm run migrate:core
npm run migrate:node
```

Voice debugging helper:

```bash
npm run dev:voice-debug
```

## Local development

From the repository root, the usual workflow is:

```bash
./scripts/dev/setup.sh backend
./scripts/dev/setup-database.sh --with-docker
./scripts/dev/start.sh backend
```

## Runtime notes

- `core` is the central platform API and gateway entry point
- `server-node` is the node-local API for guild state, messaging, attachments, and voice
- local Docker Compose definitions exist at both `docker-compose.yml` and `backend/docker-compose.yml`
- PM2 start commands are exposed through the backend workspace scripts for production-style local runs

## Related docs

- `../README.md`
- `../docs/SETUP_GUIDE.md`
- `../docs/PLATFORM_GUIDE.md`
