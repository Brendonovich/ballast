#!/usr/bin/env bash
# plan.sh: decides what .github/workflows/release.yml builds, signs and
# publishes, from the event and ref alone.
#
#   pr      pull_request: builds macOS and Windows unsigned, tests the Windows
#           setup; signs and publishes nothing.
#   dev     push to dev: 0.0.0-dev-<run number> on ballast/desktop/dev.
#   stable  workflow_dispatch on dev with a version (X.Y.Z): that version on
#           ballast/desktop/stable, then tags v<version>.
#
# Environment: EVENT, REF_NAME, SHA, INPUT_VERSION, GITHUB_REPOSITORY,
# GITHUB_RUN_NUMBER. Writes its outputs to $GITHUB_OUTPUT.
. "$(dirname "$0")/lib.sh"

case "$EVENT" in
  pull_request)
    channel="pr"
    build_channel=""
    version="0.0.0-pr-$GITHUB_RUN_NUMBER"
    sign=false
    ;;
  push)
    [ "$REF_NAME" = dev ] || die "Releases publish from dev, not $REF_NAME."
    channel=dev
    build_channel=dev
    version="0.0.0-dev-$GITHUB_RUN_NUMBER"
    sign=true
    ;;
  workflow_dispatch)
    [ "$REF_NAME" = dev ] || die "Stable releases are dispatched on dev, not $REF_NAME."
    [[ "${INPUT_VERSION:-}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
      die "A stable release needs a version X.Y.Z, not '${INPUT_VERSION:-}'."
    channel=stable
    build_channel=stable
    version=$INPUT_VERSION
    sign=true
    ;;
  *)
    die "Unexpected event $EVENT."
    ;;
esac

if [ "$channel" = stable ]; then
  notes="https://github.com/$GITHUB_REPOSITORY/releases/tag/v$version"
else
  notes="https://github.com/$GITHUB_REPOSITORY/commit/$SHA"
fi

{
  echo "sha=$SHA"
  echo "channel=$channel"
  echo "build-channel=$build_channel"
  echo "version=$version"
  echo "sign=$sign"
  echo "notes-url=$notes"
} | tee -a "$GITHUB_OUTPUT"
