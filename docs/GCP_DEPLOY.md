# OpenCom On GCP

This guide is for someone who:

- understands software and infrastructure
- has used other cloud providers
- does not want a vague "just use GCP" answer
- wants to know what to create, in what order, and why

This is written around the repo as it exists now.

## What Goes Where

Think of the OpenCom deployment like this:

- `core` = your main API and the cleanest Cloud Run service
- `node` = your server-node API; Cloud Run can host the HTTP side, but voice makes it less clean
- `media` = dedicated mediasoup/WebRTC service; do not treat this like a normal Cloud Run app for production
- `frontend`, `panel`, `support` = separate web apps
- MySQL = Cloud SQL
- Redis = Memorystore
- object/file storage = Cloud Storage or another bucket-compatible system
- CI/CD = GitHub Actions
- DNS / edge / proxy = Cloudflare

If you only want the shortest sane production answer:

- put `core` on Cloud Run
- put MySQL on Cloud SQL
- put Redis on Memorystore
- put `media` on GCE or GKE
- decide whether `node` lives on Cloud Run or next to `media`
- put Cloudflare in front of your public domains

## First: Understand The Networking

This is the part that trips people up.

Cloud Run is great for normal HTTP services. It is not a magic replacement for everything that runs in a container.

For this repo:

- `core` fits Cloud Run well
- `node` is okay on Cloud Run for normal API traffic
- `media` is not a good production Cloud Run fit because mediasoup wants its own RTC port range and lower-level networking behavior

So if your goal is "make the whole backend one-click Cloud Run", that is not the honest answer for this codebase.

The honest answer is:

- Cloud Run for the standard stateless APIs
- VM or Kubernetes for the real-time media service

## GCP Services You Actually Need

Here is the mental translation from "generic cloud" to GCP:

- container app service: Cloud Run
- managed MySQL: Cloud SQL
- managed Redis: Memorystore
- private container registry: Artifact Registry
- IAM users/roles/service identities: IAM + Service Accounts
- secrets store: Secret Manager
- VM for special networking: Compute Engine
- public entry point with TLS/custom host routing: Global external Application Load Balancer

You do not need to learn all of GCP. You need a working subset.

## Recommended OpenCom Layout

### Minimum practical layout

- `opencom-core` -> Cloud Run
- `opencom-node` -> Cloud Run or Compute Engine
- `opencom-media` -> Compute Engine or GKE
- Cloud SQL instance -> MySQL-compatible database
- Memorystore instance -> Redis
- Artifact Registry repo -> stores built images
- Secret Manager -> optional, but recommended
- Cloudflare -> public DNS and proxy

### Easiest first version

If you want the least confusing first deployment:

1. Deploy `core` to Cloud Run first.
2. Deploy `node` second.
3. Keep `media` on a VM.
4. Put Cloudflare in front after the services have real URLs.

Do not start with the media service if you are still learning GCP.

## What This Repo Already Gives You

This repo now includes:

- service-specific env files:
  - `backend/core.env`
  - `backend/node.env`
  - `backend/media.env`
- a local containerized runner:
  - `scripts/deploy/run-backend-service.sh`
- a direct GCP deploy helper:
  - `scripts/deploy/gcp-deploy.sh`

So your job is mostly:

1. create the GCP resources
2. fill out your local env files
3. deploy with `gcloud`

## Step 1: Create A GCP Project

Create one project for OpenCom unless you already have a multi-project setup you like.

Pick and write down:

- project ID
- region

Example:

- project ID: `opencom-prod`
- region: `europe-west2`

Try to keep most resources in one region unless you have a reason not to.

## Step 2: Enable The Main APIs

In GCP, services are often unavailable until their APIs are enabled.

Enable at least:

- Cloud Run Admin API
- Artifact Registry API
- IAM API
- IAM Credentials API
- Cloud SQL Admin API
- Secret Manager API
- Compute Engine API
- VPC Access API
- Redis API

If you use the console, search "APIs & Services" and enable them there.

## Step 3: Create Artifact Registry

This is where your local deploy script pushes images before Cloud Run deploys them.

Create:

- format: Docker
- repository name: something like `opencom`
- region: same region as your deployment if possible

You will use values like:

- `GCP_ARTIFACT_REGISTRY_REGION=europe-west2`
- `GCP_ARTIFACT_REGISTRY_REPOSITORY=opencom`

## Step 4: Create Cloud SQL

You need MySQL-compatible storage for the backend.

Create a Cloud SQL for MySQL instance.

Then create:

- database for `core`
- database for `node`/`media` if you keep them together, or separate if you prefer
- a DB user

For `core.env`, the app expects:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

For `node.env` and `media.env`, the app expects URL-style DB strings:

- `NODE_DATABASE_URL`
- `MEDIA_DATABASE_URL`

Example:

```env
NODE_DATABASE_URL=mysql://opencom:password@127.0.0.1:3306/ods_node
MEDIA_DATABASE_URL=mysql://opencom:password@127.0.0.1:3306/ods_node
```

Why `127.0.0.1`?

Because when Cloud Run is connected to Cloud SQL using the Cloud SQL integration, your app commonly connects through the local Cloud SQL connector path or local endpoint behavior provided by the platform setup. In this repo, the important deploy-time part is attaching the Cloud SQL instance to the service.

For Cloud Run in this repo, the helper script supports:

- `--cloudsql PROJECT:REGION:INSTANCE`

That value should be in the form:

```text
PROJECT_ID:REGION:INSTANCE_NAME
```

## Step 5: Create Redis In Memorystore

Create a Redis instance in Memorystore.

You need its connection address for:

- `REDIS_URL`

Example:

```env
REDIS_URL=redis://10.0.0.5:6379
```

This usually means you also need private networking and probably a VPC connector for Cloud Run.

## Step 6: Create Runtime Service Accounts

You should have at least:

- one deploy service account used by GitHub Actions
- one runtime service account per deployed service, or one shared runtime account if you want to keep it simpler

Suggested runtime service accounts:

- `opencom-core-runtime@PROJECT_ID.iam.gserviceaccount.com`
- `opencom-node-runtime@PROJECT_ID.iam.gserviceaccount.com`
- `opencom-media-runtime@PROJECT_ID.iam.gserviceaccount.com`

Suggested deploy service account:

- `github-deployer@PROJECT_ID.iam.gserviceaccount.com`

The deploy account needs permissions to:

- push images to Artifact Registry
- deploy/update Cloud Run
- impersonate runtime service accounts if you use that pattern

The runtime accounts need permissions based on what the app touches, for example:

- Cloud SQL Client
- Secret Manager Secret Accessor if you wire secrets that way

## Step 7: Authenticate Your Machine To GCP

You are deploying from your own machine now, so authenticate `gcloud` locally.

Basic flow:

1. install Google Cloud CLI
2. run `gcloud auth login`
3. run `gcloud auth application-default login` if you need ADC-backed tools too
4. select your project with `gcloud config set project PROJECT_ID`

You do not need GitHub OIDC or GitHub deploy secrets for this path.

## Step 7.5: Buckets And IAM

For `core` and `node`, the repo now supports native Google Cloud Storage.

Use env like:

```env
STORAGE_PROVIDER=gcs
CORE_STORAGE_BUCKET=your-core-bucket
NODE_STORAGE_BUCKET=your-node-bucket
GCS_PROJECT_ID=your-project-id
```

You do not need static storage access keys for this path.

Instead:

1. create the bucket
2. give the runtime service account access to that bucket
3. attach that service account to Cloud Run or GCE

Typical bucket role:

- `Storage Object Admin` if the service needs to create, read, and delete objects

This is the GCP equivalent of assigning a bucket-capable IAM role to the workload.

Recommended access model:

- keep the buckets private
- let the backend service account access them
- have the backend stream files to clients through API routes

That way clients do not need direct bucket URLs, and storage stays behind your auth/permission checks.

## Step 8: Fill Out Your Local Env Files

Use these as your source of truth:

- `backend/core.env`
- `backend/node.env`
- `backend/media.env`

Do not commit the real files.

The deploy script uses those files directly with Cloud Run.

## Step 9: Deploy Core First

Use the helper script:

```bash
./scripts/deploy/gcp-deploy.sh core \
  --project-id opencom-prod \
  --region europe-west2 \
  --artifact-repo opencom
```

You can optionally add:

- `--min-instances`
- `--max-instances`
- `--concurrency`
- `--cpu`
- `--memory`
- `--cloudsql`
- `--vpc-connector`
- `--service-account`

Suggested starting point for `core`:

- min instances: `0`
- max instances: `5`
- concurrency: `80`
- cpu: `1`
- memory: `1Gi`

If cold starts annoy you later, move min instances from `0` to `1`.

## Step 11: Understand Cloud Run Scaling Without Panicking

You mentioned multi-instancing and "it seems to want to do that".

That is normal.

Cloud Run is autoscaling by design.

What the knobs mean:

- `min_instances`: how many warm instances stay around even when idle
- `max_instances`: hard-ish ceiling on scale-out
- `concurrency`: how many simultaneous requests one instance can handle

Simple mental model:

- lower concurrency -> more instances sooner
- higher concurrency -> fewer instances, more work per instance
- higher max instances -> more scale capacity
- min instances above `0` -> less cold start, more cost

Safe starting defaults:

### Core

- min: `0`
- max: `5`
- concurrency: `80`

### Node

- min: `0`
- max: `3`
- concurrency: `80`

### Media

- do not think of this as normal Cloud Run scaling for production voice

## Step 10: Deploy Node

After `core` is up and healthy:

1. check the real `core` URL
2. make sure `node.env` points at it
3. update `OPENCOM_NODE_ENV` in GitHub if needed
4. deploy it

Double-check these values in `node.env`:

- `CORE_BASE_URL`
- `CORE_JWKS_URL`
- `PUBLIC_BASE_URL`
- `NODE_SERVER_ID`
- `NODE_SYNC_SECRET`
- `MEDIA_SERVER_URL`
- `MEDIA_WS_URL`

If `node` is on Cloud Run and `media` is elsewhere, `MEDIA_SERVER_URL` and `MEDIA_WS_URL` should point at the media service, not the node service.

Example command:

```bash
./scripts/deploy/gcp-deploy.sh node \
  --project-id opencom-prod \
  --region europe-west2 \
  --artifact-repo opencom \
  --cloudsql PROJECT:REGION:INSTANCE
```

## Step 11: Handle Media The Right Way

Blunt version:

- do not assume a Cloud Run deploy of `media` means production-ready voice

You can still use the helper script for experiments, staging, or non-production tests.

But for production voice:

- put `media` on GCE or GKE
- expose the required TCP/UDP RTC port range
- set `MEDIASOUP_ANNOUNCED_ADDRESS` correctly

If you are still getting the stack online, it is completely reasonable to:

- deploy `core`
- deploy `node`
- leave `media` for after everything else is stable

## Step 12: Connect Cloudflare

Cloudflare is not the deploy engine here.

Cloudflare’s job is:

- DNS
- proxying
- edge TLS
- caching/static edge behavior if you want it

The deployment flow is:

- GitHub Actions deploys to GCP
- GCP gives you service URLs
- Cloudflare points your domains at the GCP entry points

For custom domains on Cloud Run, Google recommends using a global external Application Load Balancer in front of Cloud Run rather than relying on the older limited domain mapping path.

Practical advice:

- if you already know reverse proxies/CDNs, think of Cloudflare as your public front door
- think of Cloud Run / GCE as your origin

Likely domain layout:

- `api.yourdomain.com` -> `core`
- `node.yourdomain.com` -> `node`
- `media.yourdomain.com` -> media VM/GKE
- `app.yourdomain.com` -> frontend
- `panel.yourdomain.com` -> panel

Then set the corresponding URLs in your env files.

## Step 13: Local Deploys

If you want to run the backend services locally in the same basic container form used for deployment:

```bash
./scripts/deploy/run-backend-service.sh core --rebuild
./scripts/deploy/run-backend-service.sh node --rebuild
./scripts/deploy/run-backend-service.sh media --rebuild
```

Multiple local instances:

```bash
./scripts/deploy/run-backend-service.sh core --replicas 2 --port 3100
```

That starts multiple containers and increments ports.

This is useful for:

- sanity-checking container startup
- testing env files
- getting a feel for multi-instance behavior

This is not a full production orchestrator. It is just a practical local tool.

## Recommended Order If You Want To Stay Sane

Do it in this order:

1. create GCP project
2. enable APIs
3. create Artifact Registry
4. create Cloud SQL
5. create Memorystore
6. create runtime service accounts
7. authenticate `gcloud` locally
8. fill out `core.env`, `node.env`, `media.env`
9. deploy `core`
10. deploy `node`
11. put Cloudflare in front
12. deal with `media`

If you skip around too much, you will spend your time debugging missing IAM permissions and broken URLs.

## Common Mistakes

### "I deployed to Cloud Run, why can’t it reach my database?"

Usually one of:

- Cloud SQL instance not attached to the service
- wrong DB host/value
- private networking not configured
- runtime service account missing Cloud SQL permissions

### "Why is `gcloud` failing auth?"

Usually one of:

- wrong active project
- logged into the wrong Google account
- your account lacks the needed IAM roles
- Artifact Registry or Cloud Run APIs are not enabled

### "Why is Cloudflare not working?"

Usually one of:

- DNS is pointing at the wrong origin
- custom domain not set up correctly on the GCP side
- Cloudflare proxy/TLS mode mismatch

Remember:

- GitHub deploys
- GCP runs
- Cloudflare fronts

### "Why is media/voice weird?"

Because real-time media is the least Cloud Run-shaped part of the stack.

Do not treat a voice problem like a normal stateless web API problem.

## What To Put In Each Env File

### `core.env`

Put:

- DB settings for the core DB
- Redis URL
- JWT secrets
- membership JWKs
- public app/support URLs
- node/media integration URLs
- `STORAGE_PROVIDER=gcs`
- `CORE_STORAGE_BUCKET`

### `node.env`

Put:

- node DB URL
- link back to core
- public node URL
- media URLs
- sync secret
- storage config
- `STORAGE_PROVIDER=gcs`
- `NODE_STORAGE_BUCKET`
- voice/TURN config

### `media.env`

Put:

- media DB URL
- core base URL
- media public URLs
- token secret
- allowed origins
- mediasoup networking settings

## If You Want The Simplest Possible Production Target

If you asked me what I would do with the least drama:

1. `core` on Cloud Run
2. `node` on Cloud Run only if you are okay with the voice caveats
3. `media` on a VM
4. Cloud SQL + Memorystore
5. Cloudflare in front
6. GitHub Actions as the deployment entry point

That is the "not stupid, not overcomplicated" path.

## Repo Files You Should Care About

- [backend/README.md](/home/don/development/OpenCom/backend/README.md)
- [backend/core.env.example](/home/don/development/OpenCom/backend/core.env.example)
- [backend/node.env.example](/home/don/development/OpenCom/backend/node.env.example)
- [backend/media.env.example](/home/don/development/OpenCom/backend/media.env.example)
- [scripts/deploy/gcp-deploy.sh](/home/don/development/OpenCom/scripts/deploy/gcp-deploy.sh)
- [scripts/deploy/run-backend-service.sh](/home/don/development/OpenCom/scripts/deploy/run-backend-service.sh)

## Official References

These are the main upstream docs this guide is based on:

- Cloud Run autoscaling: https://cloud.google.com/run/docs/about-instance-autoscaling
- Cloud Run concurrency: https://cloud.google.com/run/docs/about-concurrency
- Cloud Run min instances: https://cloud.google.com/run/docs/configuring/min-instances
- Cloud Run max instances: https://cloud.google.com/run/docs/configuring/max-instances
- Cloud Run custom domains / load balancer guidance: https://cloud.google.com/run/docs/mapping-custom-domains
- Cloud SQL from Cloud Run: https://cloud.google.com/sql/docs/mysql/connect-run
- Artifact Registry with Cloud Run: https://cloud.google.com/artifact-registry/docs/integrate-cloud-run
- gcloud run deploy reference: https://cloud.google.com/sdk/gcloud/reference/run/deploy
