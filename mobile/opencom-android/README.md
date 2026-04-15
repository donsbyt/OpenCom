# OpenCom Android Client

This package contains the Expo-based Android client for OpenCom.

## Status

The mobile app is still evolving, but the package is active and intended for real development work rather than being placeholder-only.

## Local development

```bash
cd mobile/opencom-android
npm install
npm run start
```

Useful scripts:

```bash
npm run android
npm run ios
npm run prebuild
npm run apk
npm run apk:relay
npm run crashlog
```

## What lives here

- mobile auth/session handling
- server, DM, and channel views
- mobile API wrappers and URL helpers
- Android build helpers and crash capture scripts

## Notes

- This package uses Expo and React Native
- Android is the main target described by the current scripts
- Some features may still lag behind the web client while mobile support continues to mature

## Related docs

- `../../README.md`
- `../../docs/PLATFORM_GUIDE.md`
