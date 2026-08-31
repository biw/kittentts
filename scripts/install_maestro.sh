#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="${MAESTRO_INSTALL_ROOT:-${repo_root}/.context/maestro}"
version="2.7.0"
expected_sha256="a4ccab6b604617e7aef6db4f885666056eabe5cfa32befaa3bc994041b8fcbb5"
archive="${install_root}/maestro.zip"

if [[ ! -x "${install_root}/maestro/bin/maestro" ]]; then
  mkdir -p "${install_root}"
  curl --fail --location --retry 3 \
    "https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${version}/maestro.zip" \
    --output "${archive}"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "${archive}" | awk '{print $1}')"
  else
    actual_sha256="$(shasum -a 256 "${archive}" | awk '{print $1}')"
  fi
  if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
    echo "Maestro checksum mismatch: expected ${expected_sha256}, got ${actual_sha256}" >&2
    exit 1
  fi
  unzip -q "${archive}" -d "${install_root}"
fi

echo "${install_root}/maestro/bin"
