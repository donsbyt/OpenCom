# OpenCom Frontend

This package contains the main web client for OpenCom.

## Responsibilities

- Authentication and account flows
- Server, channel, and DM experience
- Profile, presence, and settings UI
- Voice client controls and fallback behavior
- Extension UI integration

## Local development

```bash
cd frontend
npm install
npm run dev
```

Default dev URL: `http://localhost:5173`

To run the full local stack from the repository root instead:

```bash
./scripts/dev/start.sh all
```

## Available scripts

```bash
npm run dev
npm run build
npm run preview
npm run dev:voice-debug
```

## Environment

The frontend uses `frontend/.env` for local configuration. The shared setup scripts in `scripts/dev/` can generate and refresh this file for you.

## Related docs

- `../README.md`
- `../docs/SETUP_GUIDE.md`
- `../docs/PLATFORM_GUIDE.md`
