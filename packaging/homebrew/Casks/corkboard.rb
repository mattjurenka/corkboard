cask "corkboard" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0-rc8"
  sha256 arm:   "4e527e84a22b2be3d5598d6f6fe7820414aee1a85b9797e591a8b0c12162200d",
         intel: "bdfb8f924c5bdc3762dfa0911554ed4cdaa337d3c700b49b886e6c271a921a00"

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
