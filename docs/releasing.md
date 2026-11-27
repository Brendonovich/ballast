# Releasing Ballast desktop

Ballast ships **macOS arm64** and **Windows x64** from `.github/workflows/release.yml`. Each
release is signed, published to Ballast's own release service (`apps/release`, the anomalyco/release
protocol and publish API on a Cloudflare Worker), and installed by the app's own updater (`apps/desktop/src/main/update.ts`). Like OpenCode and Rune,
build jobs run repository code without secrets. Sign and publish jobs run in the `release`
environment, check out only `.github/release/`, and treat artifacts as data checked against
SHA-256 digests.

| Trigger | Channel | Version | Signed | Published |
| --- | --- | --- | --- | --- |
| Pull request | none | `0.0.0-pr-<run>` | no | no. Builds both platforms and tests the Windows setup. |
| Push to `dev` | `dev` | `0.0.0-dev-<run>` | yes | `ballast/desktop/dev` |
| Dispatch on `dev` with `version: X.Y.Z` | `stable` | `X.Y.Z` | yes | `ballast/desktop/stable`, plus tag and GitHub release `vX.Y.Z` |

## What each release contains

| Target | File | Used by |
| --- | --- | --- |
| `macos-arm64` | `Ballast-<v>-macos-arm64.zip` (notarized and stapled `Ballast.app`) | the updater (Squirrel.Mac) |
| `macos-arm64-dmg` | `Ballast-<v>-macos-arm64.dmg` (signed, notarized, stapled) | people |
| `windows-x64-setup` | `Ballast-<v>-windows-x64-setup.exe` (one-click, per-user NSIS; Authenticode-signed once Azure is configured) | people and the updater |

Download links that always point at a channel's current build:
`<RELEASE>/ballast/desktop/<channel>/macos-arm64-dmg` and `…/windows-x64-setup`. `<RELEASE>` is the
service URL, `https://ballast-release.brendonovich.workers.dev/release` unless the
`BALLAST_RELEASE_ORIGIN` repository variable says otherwise.

Job graph: `plan` → `build` (macOS and Windows, unsigned) → `sign-macos` (sign inside out,
notarize, staple, zip and dmg) and `sign-windows` (Authenticode every exe, dll and node file) →
`package-windows` (NSIS around the signed app, then a silent install/uninstall test) →
`sign-windows-setup` → `publish` (both platforms in one release) → `tag` (stable only).

## How the app updates

- Only CI builds check for updates. `script/pack.mjs` stamps `out/release.json` with the
  channel and the service URL (`BALLAST_RELEASE_ORIGIN`). Dev and local builds report `unavailable`.
- The app checks `<RELEASE>/ballast/desktop/<channel>.json` 10 seconds after launch,
  then hourly (every 10 minutes on dev). It sends `User-Agent: ballast/<channel>/<version>` and
  applies the protocol's client rules (`src/main/update/protocol.ts`, tested against the
  service's vectors in `test/fixtures/release-protocol/`). It never orders versions: whatever
  release is current on the channel gets installed, so a rollback is a `promote`.
- Only a **direct** install updates itself:
  - **macOS:** `Ballast.app` is in a writable location and isn't translocated. Otherwise the app
    links to the DMG.
  - **Windows:** the NSIS setup wrote `install.json` (UTF-16LE: `{"app":"ballast","artifact":"desktop",
    "channel":…,"method":"direct","root":<install dir>}`) and its root matches the running app.
    Otherwise the app links to the setup.
- The download is checked against the manifest's size and SHA-256, then:
  - **macOS:** handed to Squirrel.Mac through a loopback feed. Squirrel also requires the new
    bundle to satisfy the running app's code-signing requirement.
  - **Windows:** run as `setup.exe --updated /S --force-run` after the app quits.
- Install stops the background service first (`prepareForAppUpdate`). The relaunched app starts
  its own service.

## One-time setup

1. **Repository.** Push to `github.com/brendonovich/ballast` and create the `dev` branch.
2. **Signing today.** macOS is signed with the Developer ID *Spacedrive Technology Inc. (XF923AZS22)*
   and notarized with an individual App Store Connect key, so `APPLE_NOTARY_ISSUER_ID` is empty.
   Windows ships **unsigned** until the `AZURE_CLIENT_ID` repository variable exists. Then the
   `sign-windows` jobs turn on by themselves.
3. **`release` environment** (Settings → Environments). Limit deployment branches to `dev`.
   Optionally add required reviewers for stable.
   - Secrets:
     - `APPLE_SIGNING_CERTIFICATE`: base64 of a **Developer ID Application** `.p12`
     - `APPLE_SIGNING_CERTIFICATE_PASSWORD`: only if the `.p12` has a password
     - `APPLE_NOTARY_KEY`: App Store Connect API key `.p8`, as PEM or base64
   - Variables:
     - `APPLE_TEAM_ID`, `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID`
     - `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
     - `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
       `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE`
4. **Azure Artifact Signing** (not set up yet). Give the app registration (`AZURE_CLIENT_ID`) a federated credential
   for subject `repo:brendonovich/ballast:environment:release`, and the *Artifact Signing
   Certificate Profile Signer* role on the profile. The workflow logs in over OIDC, so there is no
   client secret.
5. **Deploy the release service** with `pnpm --filter @ballast/release deploy`, using the same
   Cloudflare credentials as `apps/cloud`. The deploy prints the Worker URL. If it isn't
   `https://ballast-release.brendonovich.workers.dev`, set the repository variable
   `BALLAST_RELEASE_ORIGIN` to `<url>/release`. See `apps/release/README.md`.

6. **Settle the bundle id before the first release.** It's `dev.ballast.agent` (`BALLAST_APP_ID`).
   Squirrel.Mac only accepts an update whose signature satisfies the installed app's designated
   requirement, which includes the bundle id and team. Changing either later strands existing
   installs on their current version.

## Rehearsing locally

`BALLAST_VERSION=0.0.0-dev-1 BALLAST_CHANNEL=dev node apps/desktop/script/pack.mjs --out <dir>`
builds a release-stamped app. Point it at any server that serves a protocol manifest with
`BALLAST_RELEASE_URL=http://127.0.0.1:<port>/release`. Squirrel needs both builds signed with the same
identity; a local Apple Development identity works.
