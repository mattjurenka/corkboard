cask "corkboard" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0-rc6"
  sha256 arm:   "9ba9a59f2bcca13c2281b5f7ab7839f34c739810a6ab18af5c96694ad613c552",
         intel: "e6659f925796dbffca367523ec9ac11da032b0a90f599c4c746e9cda6a58ac3a"

  url "https://github.com/mattjurenka/corkboard/releases/download/v#{version}/corkboard-#{version}-mac-#{arch}.dmg",
      verified: "github.com/mattjurenka/corkboard/"
  name "corkboard"
  desc "Neovim with Claude Code agents beside it"
  homepage "https://corkboard.fyi/"

  # github_releases leaves out pre-releases unless given a block, and so far
  # there are only rcs.
  livecheck do
    url :url
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
