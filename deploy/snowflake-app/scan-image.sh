#!/usr/bin/env bash
# Scans the ZLens app image before it becomes a version of the app package. Snowflake's security
# review rejects images with fixable critical or high CVEs and asks providers whether images were
# scanned for malware, so run this on every image you are about to release.
#
#   deploy/snowflake-app/scan-image.sh zlens-snowflake:<tag>
#
# 1. Trivy: fixable critical and high CVEs fail the scan (CI runs the same check).
# 2. ClamAV: the image's whole filesystem, with fresh signatures.
# Needs Docker. Uses the official aquasec/trivy and clamav/clamav-debian images.
set -euo pipefail

image="${1:?usage: scan-image.sh <image>}"
trivy_image="aquasec/trivy:0.76.2"
clamav_image="clamav/clamav-debian:stable"  # multi-platform (the plain clamav image has no arm64 build)

echo "== Runs as: $(docker inspect --format '{{.Config.User}}' "$image")"
test "$(docker inspect --format '{{.Config.User}}' "$image")" = 1000:1000 || { echo "the app image must run as uid 1000 (docker build --target snowflake-app)" >&2; exit 1; }

echo "== Minimal: no shell, no package manager"
docker run --rm --entrypoint /nodejs/bin/node "$image" -e '
  const found = ["/bin/sh", "/bin/bash", "/usr/bin/apt", "/usr/bin/dpkg", "/usr/local/bin/npm", "/usr/bin/npm"].filter((p) => require("fs").existsSync(p));
  if (found.length) { console.error("not minimal, found: " + found.join(", ")); process.exit(1); }
  console.log("no shell, no package manager");'

# V14: the copy to the backup stage ran tar, gzip and sync, which this image does not have. Every program the
# app code runs must be in the image, or be a laptop-only use listed in check-programs.mjs.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "== Every program the app code runs is in the image"
docker run --rm -v "$here/check-programs.mjs:/zlens-checks/check-programs.mjs:ro" --entrypoint /nodejs/bin/node "$image" \
  /zlens-checks/check-programs.mjs /opt/dql

echo "== The project copy for the backup stage is made and restored in the image"
docker run --rm --entrypoint /nodejs/bin/node "$image" --input-type=module -e '
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { packProject, unpackProject } = await import("/opt/dql/dist/project-archive.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zlens-copy-"));
  fs.mkdirSync(path.join(root, ".dql", "history"), { recursive: true });
  fs.writeFileSync(path.join(root, ".dql", "history", "v1.dql"), "an earlier version");
  fs.writeFileSync(path.join(root, "dql.config.json"), "{}");
  const file = root + ".tar.gz";
  await packProject(root, file, () => false);
  const into = fs.mkdtempSync(path.join(os.tmpdir(), "zlens-restore-"));
  await unpackProject(file, into);
  if (fs.readFileSync(path.join(into, ".dql", "history", "v1.dql"), "utf8") !== "an earlier version") process.exit(1);
  console.log("made and restored " + fs.statSync(file).size + " bytes with no tar or gzip");'

echo "== Trivy: fixable critical and high CVEs"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v zlens-trivy-cache:/root/.cache "$trivy_image" image \
  --scanners vuln --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 --no-progress "$image"

echo "== ClamAV: the image's filesystem"
work=$(mktemp -d)
trap 'rm -rf "$work"; docker rm -f zlens-scan-export >/dev/null 2>&1 || true' EXIT
docker create --name zlens-scan-export "$image" >/dev/null
mkdir -p "$work/rootfs"
docker export zlens-scan-export | tar -x -C "$work/rootfs" --exclude='dev/*' 2>/dev/null || true
docker run --rm -v "$work/rootfs:/scan:ro" --entrypoint sh "$clamav_image" -c \
  'freshclam --quiet --stdout >/dev/null 2>&1; clamscan --recursive --infected /scan'
