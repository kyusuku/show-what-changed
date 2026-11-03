#!/bin/sh
set -eu

if [ "${1:-}" = '--help' ]; then
  printf '%s\n' 'Usage: sh scripts/linux-gate/install-lsof.sh /absolute/writable/prefix' \
    'Builds pinned lsof 4.99.7. Requires Linux, curl, sha256sum, tar, make, a C compiler, pkg-config, libtirpc and libselinux development files.' \
    'Installs only lsof, its license, and source provenance. Does not install system packages or change PATH.'
  exit 0
fi
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Expected one absolute installation prefix; use --help.' >&2
  exit 2
fi
swc_lsof_prefix=$1
case "$swc_lsof_prefix" in /*) ;; *) printf '%s\n' 'Installation prefix must be absolute.' >&2; exit 2 ;; esac
[ "$(uname -s)" = Linux ] || { printf '%s\n' 'This installer requires Linux.' >&2; exit 2; }
for swc_lsof_tool in curl sha256sum tar make cc pkg-config install mktemp; do
  command -v "$swc_lsof_tool" >/dev/null 2>&1 || { printf 'Missing build prerequisite: %s\n' "$swc_lsof_tool" >&2; exit 2; }
done
pkg-config --exists libtirpc libselinux || { printf '%s\n' 'Install libtirpc and libselinux development packages before running this installer.' >&2; exit 2; }
mkdir -p "$swc_lsof_prefix/bin" "$swc_lsof_prefix/share/licenses/lsof" "$swc_lsof_prefix/share/show-what-changed"
[ -w "$swc_lsof_prefix/bin" ] || { printf '%s\n' 'Installation prefix is not writable.' >&2; exit 2; }

swc_lsof_url=https://github.com/lsof-org/lsof/releases/download/4.99.7/lsof-4.99.7.tar.gz
swc_lsof_sha256=4a10391aab0b8ce1f539e82a1966693b2a6cf225972a6504ebb7ec4fa71675de
swc_lsof_work=$(mktemp -d "${TMPDIR:-/tmp}/swc-lsof.XXXXXXXX")
trap 'rm -rf "$swc_lsof_work"' EXIT HUP INT TERM
curl --fail --location --show-error --retry 3 --connect-timeout 30 --max-time 300 "$swc_lsof_url" -o "$swc_lsof_work/source.tar.gz"
printf '%s  %s\n' "$swc_lsof_sha256" "$swc_lsof_work/source.tar.gz" | sha256sum --check -
tar -xzf "$swc_lsof_work/source.tar.gz" -C "$swc_lsof_work"
cd "$swc_lsof_work/lsof-4.99.7"
./configure --prefix="$swc_lsof_prefix" --disable-liblsof --with-libtirpc --with-selinux
make -j2 lsof
install -m 0755 lsof "$swc_lsof_prefix/bin/lsof"
install -m 0644 COPYING "$swc_lsof_prefix/share/licenses/lsof/COPYING"
printf 'version=4.99.7\nsource=%s\nsha256=%s\nconfigure=--disable-liblsof --with-libtirpc --with-selinux\n' \
  "$swc_lsof_url" "$swc_lsof_sha256" > "$swc_lsof_prefix/share/show-what-changed/lsof-source.txt"
"$swc_lsof_prefix/bin/lsof" -v
printf '\nInstalled lsof 4.99.7 at %s/bin/lsof. Add %s/bin to PATH for show-what-changed.\n' "$swc_lsof_prefix" "$swc_lsof_prefix"
