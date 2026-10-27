# The `coding` capability's guest half: the tools an agent needs to build
# and test a repo. Claude Code itself is the installing flake's (its own
# package and overlay), so it is a capability of its own there.
{ pkgs, ... }: {
  environment.systemPackages = with pkgs; [
    git
    gnumake
    gcc
    nodejs
    bun
    python3
    ripgrep
    fd
    jq
    curl
  ];
}
