#!/usr/bin/env bash
set -euo pipefail

if [[ "$RUNNER_OS" != Linux ]]; then
  exec "$@"
fi

image='mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe'
version=$(node -p 'require("playwright/package.json").version')
if [[ "$image" != "mcr.microsoft.com/playwright:v${version}-noble@"* ]]; then
  echo "Update the browser image to match the installed Playwright $version." >&2
  exit 1
fi

# Use the Node selected by the matrix and the same UID that built the workspace.
node_root=$(node -p 'require("node:path").resolve(process.execPath, "../..")')
scratch="$RUNNER_TEMP/flowstride-browser"
mkdir -p "$scratch/home/.cache"
# Some CLI tests intentionally launch with a minimal environment. Give those
# children the image's browsers through Playwright's normal user cache as well.
ln -sfn /ms-playwright "$scratch/home/.cache/ms-playwright"

exec docker run --rm --init --shm-size=1g \
  --user "$(id -u):$(id -g)" \
  --volume /etc/passwd:/etc/passwd:ro \
  --volume "$scratch/home:$HOME" --env HOME \
  --volume "$scratch:$scratch" \
  --volume "$PWD:$PWD" --workdir "$PWD" \
  --volume "$node_root:/opt/flowstride-node:ro" \
  --env PATH=/opt/flowstride-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright --env PLAYWRIGHT_SKIP_BROWSER_GC \
  --env CI --env GITHUB_ACTIONS --env FLOWSTRIDE_THREE_BUILD \
  "$image" "$@"
