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
test "$(docker inspect --format '{{.Config.User}}' "$image")" = node || { echo "the app image must run as node (ZLENS_USER=node)" >&2; exit 1; }

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
