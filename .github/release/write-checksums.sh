#!/usr/bin/env bash
# write-checksums.sh <dir>: writes <dir>/SHA256SUMS for every file under <dir>
# and prints that manifest's digest. Every release artifact carries this
# manifest, and the job that made it reports the digest as a job output; the
# jobs that use the artifact check both (verify-artifacts.sh).
. "$(dirname "$0")/lib.sh"

cd "$(posix "$1")"
files=$(mktemp)
manifest=$(mktemp)
find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort > "$files"
[ -s "$files" ] || die "Nothing to upload in $1"
# Batched: one process per file costs minutes for an unpacked Windows app on Git Bash.
tr '\n' '\0' < "$files" | xargs -0 -n 500 "${sha256_tool[@]}" > "$manifest"
rm -f "$files"
mv "$manifest" SHA256SUMS
cat SHA256SUMS >&2
sha256 SHA256SUMS | cut -c1-64
