# Container Images

SonarScope publishes two container images to GitHub Container Registry (GHCR):

- `ghcr.io/<owner>/sonarscope-api`
- `ghcr.io/<owner>/sonarscope-web`

## Publish Workflow

Workflow file: `.github/workflows/publish-images.yml`

Triggers:

- push to `main`
- push tag `v*`
- manual trigger (`workflow_dispatch`)

Permissions:

- `contents: read`
- `packages: write`

## Tag Strategy

- `latest` on default branch
- `main` on default branch
- `sha-<shortsha>` on every publish
- `vX.Y.Z` passthrough for release tags

## Compose Modes

- Deploy mode (pull images): `deploy/docker-compose.yml` + `deploy/.env.deploy`
- Dev mode (build local): `deploy/docker-compose.dev.yml` + `deploy/.env.dev`

Set package visibility to public in GitHub Packages for anonymous pulls.
