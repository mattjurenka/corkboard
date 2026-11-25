cask "corkboard" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0-rc11"
  sha256 arm:   "74f1e52c1ace1b482cadd70e07b5a4f80997b50dc95cbcef5514d5968800fa2e",
         intel: "0b6d7bbf6173490929d9ba4ee3229474db55cf22b3807b7b0878ec5c1bfebe46"

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
