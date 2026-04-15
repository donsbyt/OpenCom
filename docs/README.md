# OpenCom Documentation

This directory contains the Markdown source documents for contributor-facing docs and a static docs portal at `docs/site`.

## What is here

- API documentation (Core + Server Node)
- Extension SDK docs
- setup and contributor guides
- platform behavior and capability references

Primary Markdown references:

- `README.md`
- `CONTRIBUTING.md`
- `docs/SETUP_GUIDE.md`
- `docs/PLATFORM_GUIDE.md`
- `docs/extensions-sdk.md`

## Local preview

```bash
./scripts/docs/serve.sh
```

Then open `http://localhost:4173`.

Helpful utilities:

```bash
./scripts/docs/check-links.sh
./scripts/docs/new-page.sh api-webhooks "Webhook API"
```

## Deploy options

### GitHub Pages

1. Push repo to GitHub.
2. In Pages settings, set source to branch + `/docs/site`.
3. Your docs are served as static files.

### Netlify

- Build command: none
- Publish directory: `docs/site`

### Cloudflare Pages

- Framework preset: None
- Build command: none
- Output directory: `docs/site`

### Any VPS (nginx/Caddy)

Serve the `docs/site` directory directly as static files.

## Editing docs

When possible, update the Markdown source documents first and then bring `docs/site/*.html` in line if the static portal needs the same information.

Main pages:

- `docs/site/index.html`
- `docs/site/quickstart.html`
- `docs/site/api-core.html`
- `docs/site/api-server-node.html`
- `docs/site/extensions-sdk.html`
- `docs/site/guides.html`
- `docs/site/operations.html`
