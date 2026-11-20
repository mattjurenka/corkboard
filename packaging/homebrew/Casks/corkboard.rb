cask "corkboard" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0-rc10"
  sha256 arm:   "ddb6041bd141b412843ebfcdfed0bff78f77e530ce1b2be4e471522f2528ca6c",
         intel: "dde10f7df73824a2df21e8aeba5826453049aae9b90769a4030a67ab087c3ce4"

  # Through corkboard.fyi, which counts the download and sends it on to the
  # GitHub release.
  url "https://corkboard.fyi/d/corkboard-#{version}-mac-#{arch}.dmg?r=brew"
  name "corkboard"
  desc "Neovim with Claude Code agents beside it"
  homepage "https://corkboard.fyi/"

  # github_releases leaves out pre-releases unless given a block, and so far
  # there are only rcs.
  livecheck do
    url "https://github.com/mattjurenka/corkboard"
    regex(/^v?(\d+(?:\.\d+)+(?:-rc\d+)?)$/i)
    strategy :github_releases do |json, regex|
      json.map { |release| release["tag_name"]&.[](regex, 1) }
    end
  end

  auto_updates true
  depends_on formula: ["ripgrep", "fd"]
  depends_on macos: :ventura

  app "corkboard.app"

  zap trash: [
    "~/Library/Application Support/corkboard",
    "~/Library/Caches/app.corkboard",
    "~/Library/Caches/app.corkboard.ShipIt",
    "~/Library/Logs/corkboard",
    "~/Library/Preferences/app.corkboard.plist",
    "~/Library/Saved Application State/app.corkboard.savedState",
  ]
end
