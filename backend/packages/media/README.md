# Media Service Migration Notes

This package runs the dedicated voice/media service for OpenCom.

What moved here:
- WebSocket voice signaling on `/gateway`
- mediasoup workers, routers, transports, producers and consumers
- in-memory voice/session lifecycle and disconnect cleanup
- media-token validation before a client can join a room

What stays in the app/backend:
- user authentication
- room access checks
- business/API logic
- issuing short-lived media access tokens

Local run:

```bash
cd backend
npm run dev:media
```

Production notes:
- Bind the service on `MEDIA_HOST=0.0.0.0`
- Set `MEDIA_WS_URL` to the public `ws://` or `wss://` client URL
- Set `MEDIA_ALLOWED_ORIGINS` to your web/mobile origins
- Set `MEDIASOUP_ANNOUNCED_ADDRESS` to the EC2 public IP or DNS name
- Open the full `MEDIASOUP_RTC_MIN_PORT`-`MEDIASOUP_RTC_MAX_PORT` range for UDP/TCP on the media instance

The main app/backend now issues room-scoped media tokens and returns the dedicated media URL to both normal server voice rooms and private calls.
