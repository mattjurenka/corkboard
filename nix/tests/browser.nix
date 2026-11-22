# `nix build .#checks.x86_64-linux.browser`: a session's browser taken over
# from the phone. The guest has the browser capability's guest half
# (fleet/caps/browser.nix) and its agent's MCP server opens a sign-in page;
# the host, as fleetd, reaches its Chromium on the forwarded DevTools port,
# lays it out for a phone, types the login in and puts it back
# (browser-takeover.ts). DevTools itself stays on the guest's loopback.
{ pkgs, src }:
let
  fleetSrc = pkgs.lib.fileset.toSource {
    root = src;
    fileset = pkgs.lib.fileset.unions [ (src + "/fleet/fleetd") (src + "/lib/dict.ts") (src + "/nix/tests/browser-takeover.ts") ];
  };
  page = pkgs.writeTextDir "login.html" ''
    <!doctype html><title>Sign in</title>
    <form onsubmit="event.preventDefault(); document.title = 'in:' + u.value">
      <input id="u" style="position:fixed;top:0;left:0;width:100%;height:50%;font-size:32px">
    </form>
  '';
  # The agent: its MCP server, told to open the page, and kept open.
  agent = pkgs.writeShellScript "agent" ''
    mcp=$(${pkgs.lib.getExe pkgs.jq} -r .mcpServers.browser.command /etc/fleet/mcp/browser.json)
    {
      echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
      sleep 2
      echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
      echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"http://127.0.0.1:8000/login.html"}}}'
      exec sleep infinity
    } | BROWSER_OUTPUT_DIR=/tmp/browser-out "$mcp"
  '';
in
pkgs.testers.runNixOSTest {
  name = "corkboard-browser";

  nodes = {
    guest = { ... }: {
      imports = [ ../../fleet/caps/browser.nix ];
      virtualisation.memorySize = 2048;
      environment.systemPackages = [ pkgs.curl ];
      virtualisation.cores = 2;
      # A slot's tap is its eth0; the test's network is eth1 here.
      networking.firewall.interfaces.eth1.allowedTCPPorts = [ 9223 ];
      systemd.services.site = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig.ExecStart = "${pkgs.lib.getExe pkgs.python3} -m http.server 8000 --bind 127.0.0.1 --directory ${page}";
      };
      systemd.services.agent = {
        after = [ "site.service" ];
        environment.HOME = "/var/lib/agent";
        serviceConfig = { ExecStart = agent; StateDirectory = "agent"; StandardOutput = "file:/tmp/agent.log"; };
      };
    };
    host = { ... }: {
      environment.systemPackages = [ pkgs.bun pkgs.curl ];
    };
  };

  testScript = { nodes, ... }: let guest = nodes.guest.networking.primaryIPAddress; in ''
    start_all()
    guest.wait_for_unit("fleet-browser-view.service")
    guest.wait_for_unit("site.service")
    guest.wait_until_succeeds("curl -sf http://127.0.0.1:8000/login.html")
    host.wait_for_unit("multi-user.target")

    # No browser yet: fleetd hears so.
    host.fail("curl -sf --max-time 5 http://${guest}:9223/json/list")

    guest.succeed("systemctl start agent.service")
    guest.wait_until_succeeds("curl -sf http://127.0.0.1:9222/json/list | grep -q 'Sign in'", timeout=180)

    # Through the forward, by its IP, as fleetd reaches it; never DevTools' own port.
    host.succeed("curl -sf http://${guest}:9223/json/list | grep -q 'Sign in'")
    host.fail("curl -sf --max-time 5 http://${guest}:9222/json/list")

    print(host.succeed("cp -r ${fleetSrc} /tmp/src && chmod -R u+w /tmp/src && cd /tmp/src && bun nix/tests/browser-takeover.ts ${guest}"))

    # The agent's browser still works after.
    guest.succeed("curl -sf http://127.0.0.1:9222/json/list | grep -q 'in:me@example.com'")
  '';
}
