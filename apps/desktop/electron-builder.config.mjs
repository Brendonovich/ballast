// electron-builder configuration for @ballast/desktop.
//
// The service stage is deliberately outside app.asar: extraResources copies
// build-service/ to Contents/Resources/service/, and the launcher copies that
// directory into <userData>/service/<version>/ before running it.
const appId = process.env.BALLAST_APP_ID ?? "dev.ballast.agent";
const updateUrl = process.env.BALLAST_UPDATE_URL;

/** @type {import("electron-builder").Configuration} */
export default {
  appId,
  productName: "Ballast",
  artifactName: "ballast-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "package.json", "!**/*.map"],
  extraResources: [
    {
      from: "build-service",
      to: "service",
    },
  ],
  asar: true,
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.utilities",
    // Local builds are unsigned. Release builds set CSC_IDENTITY_AUTO_DISCOVERY
    // and remove this override.
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
  },
  ...(updateUrl ? { publish: [{ provider: "generic", url: updateUrl }] } : {}),
};
