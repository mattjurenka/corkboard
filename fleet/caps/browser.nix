# The `browser` capability's guest half: a headless Chromium its agent drives
# through an MCP server (./browser-mcp.ts). Nothing runs until the agent's
# first browser call, and which extensions it has is that run's to say.
{ pkgs, lib, ... }:
let
  mcp = pkgs.writeShellApplication {
    name = "fleet-browser-mcp";
    runtimeInputs = [ pkgs.unzip ];
    text = ''
      export PLAYWRIGHT_MCP_ROOT=${pkgs.playwright-mcp}/lib/node_modules/@playwright/mcp
      export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
      export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
      exec ${lib.getExe pkgs.nodejs} ${./browser-mcp.ts}
    '';
  };
in
{
  environment.etc."fleet/mcp/browser.json".text = builtins.toJSON {
    mcpServers.browser = {
      type = "stdio";
      command = lib.getExe mcp;
      args = [ ];
      # Where its screenshots and traces land: the outbox comes home.
      env.BROWSER_OUTPUT_DIR = "/mnt/outbox/browser";
    };
  };

  # Its DevTools port on the tap, for fleetd to stream the page to the phone
  # and take the user's taps and typing (fleet/fleetd/browser.ts). Chromium
  # keeps it on loopback; the host's rules let only the host reach the tap.
  systemd.services.fleet-browser-view = {
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${lib.getExe pkgs.socat} TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222";
      DynamicUser = true;
      Restart = "always";
    };
  };
  networking.firewall.interfaces.eth0.allowedTCPPorts = [ 9223 ];

  # A browser with no fonts draws its text as nothing.
  fonts = {
    enableDefaultPackages = true;
    packages = with pkgs; [ dejavu_fonts liberation_ttf noto-fonts noto-fonts-color-emoji ];
  };
}
