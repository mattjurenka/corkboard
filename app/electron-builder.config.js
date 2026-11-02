// The packaged app, for electron-builder (`bun run dist` here, after
// scripts/build-bridge.ts): main.js and bridge.js, with the compiled bridge,
// its resources and Neovim from dist/bridge/<os>-<arch> in
// resources/bridge. Out to dist/app, and with --publish, to a draft GitHub
// release, which electron-updater then reads.
//
// Signing is whatever the environment has; without it, unsigned:
//   macOS     CSC_LINK, CSC_KEY_PASSWORD (a Developer ID .p12), notarized
//             when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID are set
//   Windows   Azure Trusted Signing when AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT,
//             AZURE_SIGN_PROFILE and AZURE_SIGN_PUBLISHER are set (with
//             AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET to sign
//             in), else WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD for a .pfx

const env = process.env;
const azure = env.AZURE_SIGN_ENDPOINT && env.AZURE_SIGN_ACCOUNT && env.AZURE_SIGN_PROFILE && env.AZURE_SIGN_PUBLISHER;

export default {
  appId: "app.corkboard",
  productName: "corkboard",
  copyright: "Copyright © 2026 Matt Jurenka",
  directories: { output: "../dist/app", buildResources: "build" },
  files: ["main.js", "bridge.js", "package.json"],
  extraResources: [{ from: "../dist/bridge/${os}-${arch}", to: "bridge", filter: ["**/*"] }],
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  publish: { provider: "github", owner: "mattjurenka", repo: "corkboard", releaseType: "draft" },

  mac: {
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["x64", "arm64"] },
      { target: "zip", arch: ["x64", "arm64"] },
    ],
    icon: "build/icon.icns",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
  },
  dmg: { artifactName: "${productName}-${version}-mac-${arch}.${ext}" },

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    ...(azure
      ? {
          azureSignOptions: {
            endpoint: env.AZURE_SIGN_ENDPOINT,
            codeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
            certificateProfileName: env.AZURE_SIGN_PROFILE,
            publisherName: env.AZURE_SIGN_PUBLISHER,
          },
        }
      : {}),
  },
  nsis: { oneClick: true, perMachine: false, artifactName: "${productName}-${version}-win-${arch}-setup.${ext}" },

  linux: {
    target: [
      { target: "AppImage", arch: ["x64", "arm64"] },
      { target: "deb", arch: ["x64", "arm64"] },
      { target: "tar.gz", arch: ["x64", "arm64"] },
    ],
    icon: "build/icons",
    category: "Development",
    executableName: "corkboard",
    synopsis: "Neovim with Claude Code agents beside it",
    maintainer: "Matt Jurenka <m@trystable.co>",
    desktop: { entry: { StartupWMClass: "corkboard", Keywords: "neovim;vim;claude;agents;kanban;" } },
  },
  deb: {
    // electron-builder's own, and git, which corkboard can't do without.
    depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "git"],
    recommends: ["ripgrep", "fd-find"],
  },
};
