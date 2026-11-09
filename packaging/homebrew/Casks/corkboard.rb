cask "corkboard" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0-rc9"
  sha256 arm:   "022e00ac4b538607ed786ace1e1057e92bcca9ffb380f1f2d74e6a9d4911652c",
         intel: "44fb5eaa5c76ce8d350865c9951f4193db863e9242a86a86af6e6319f4d37588"

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
