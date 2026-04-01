# OpenCom

OpenCom is an open source communication platform with a split architecture:

- `backend/packages/core`: central platform API for accounts, auth, social features, invites, and platform services
- `backend/packages/server-node`: server-hosted guild, channel, message, attachment, and voice functionality
- `frontend`: main web client
- `panel`: standalone platform admin panel
- `client`: desktop Electron wrapper around the web client
- `mobile/opencom-android`: Expo-based Android client
- `Extensions`: server and client extension projects plus the extension SDK
- `support`: support portal for public tickets and staff ticket handling

## What the repo includes

### Platform services

- Account registration, login, refresh, and session management
- Presence, profile, invite, and server registry flows
- Direct messages, friend requests, and social graph features
- Guilds, channels, roles, moderation, attachments, and voice
- Extension loading and server-side command execution

### Client surfaces

- Web client for the main day-to-day product experience
- Desktop wrapper with a local rich-presence bridge
- Android client for mobile access
- Admin panel and support portal for operations workflows

## Quick start

### Prerequisites

- Node.js 22 or newer for backend development
- npm
- Docker with Compose support for the easiest local database/Redis setup

### Recommended local setup

```bash
./scripts/dev/setup.sh all
./scripts/dev/setup-database.sh --with-docker
./scripts/dev/start.sh all
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Core API: `http://localhost:3001`
- Server Node: `http://localhost:3002`
- Admin panel: `http://localhost:5175`
- Support portal: `http://localhost:5174` when run separately

## Common development commands

### Start services

```bash
./scripts/dev/start.sh all
./scripts/dev/start.sh backend
./scripts/dev/start.sh frontend
./scripts/dev/start.sh panel
```

### Rebuild a broken local environment

```bash
./scripts/dev/reconfigure.sh --yes
```

This regenerates local env files, clears generated backend runtime state, recreates the local database stack, and reruns migrations. Add `--with-minio` to include the optional object-storage stack.

### Docs preview

```bash
./scripts/docs/serve.sh
```

### Docker launchers

The helper launchers in `./docker/` wrap the Docker-based workflows:

- `./docker/dev` for local development
- `./docker/prod` for production-style local runs

Examples:

```bash
./docker/dev all
./docker/dev up node
./docker/prod up all
./docker/prod status
```

## Self-hosted server node workflow

If your goal is to create and run a self-hosted node:

```bash
./scripts/ops/create-server.sh
./scripts/ops/start-server.sh <server-name>
```

If those scripts do not match your environment cleanly yet, please open an issue or pull request. Keeping self-hosting practical is an active goal for the project.

## Documentation map

- `docs/SETUP_GUIDE.md`: local setup and environment guidance
- `docs/PLATFORM_GUIDE.md`: platform capabilities and API surface
- `docs/extensions-sdk.md`: extension SDK guide
- `docs/README.md`: static docs portal notes
- `CONTRIBUTING.md`: contributor workflow and documentation expectations

## Support the project

OpenCom includes an in-app boost subscription flow for people who want to support hosting and ongoing development. Using the platform, opening issues, improving docs, and contributing fixes are all valuable forms of support too.
