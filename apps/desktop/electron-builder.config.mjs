// electron-builder configuration for @ballast/desktop. script/pack.mjs drives it.
//
// The service stage is deliberately outside app.asar: extraResources copies
// build-service/service/ to Contents/Resources/service/, and the launcher copies that
// directory into <userData>/service/<version>/ before running it.
//
// Builds are always unsigned here. The release workflow signs the macOS app
// and the Windows app/installer afterwards (.github/release/), and the app
// updates itself from anoma.ly/release (src/main/update.ts), so there is no
// electron-updater publish feed.
const appId = process.env.BALLAST_APP_ID ?? "dev.ballast.agent";
const version = process.env.BALLAST_VERSION;

/** @type {import("electron-builder").Configuration} */
export default {
  appId,
  productName: "Ballast",
  executableName: "Ballast",
  artifactName: "Ballast-${version}-${os}-${arch}.${ext}",
  ...(version ? { extraMetadata: { version } } : {}),
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "package.json", "!**/*.map"],
  extraResources: [
    {
      // build-service/service: electron-builder always drops a node_modules
      // directly under an extraResources source, so the stage is nested.
      from: "build-service",
      to: ".",
      filter: ["service/**/*"],
    },
  ],
  asar: true,
  // Builds without an update channel (pull requests, local packs) are never published, so their
  // setup skips the slow LZMA pass.
  compression: process.env.BALLAST_CHANNEL ? "normal" : "store",
  publish: null,
  mac: {
    target: ["dir"],
    category: "public.app-category.utilities",
    identity: null,
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: true,
    // Written by script/pack.mjs: the direct-install receipt (install.json).
    include: "build-installer/installer.nsh",
  },
};
