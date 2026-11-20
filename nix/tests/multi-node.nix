# `nix build .#checks.x86_64-linux.multi-node`: one account across three
# nodes in VMs, through a relay in a fourth. alpha makes the account, beta
# recovers it from the phrase, gamma pairs with alpha's approval; then
# cards, brain notes and episodes go between them over the relay, the
# leader is named and Forgejo runs on it alone, and when it dies the
# leadership and the forge move on.
#
# The relay is relay/ under nixpkgs' wrangler (its own workerd), as
# `wrangler dev --local`: no Cloudflare, no node_modules. Its ORIGIN is the
# URL the nodes use, http://relay:8787.
{ pkgs, corkboard, src }:
let
  relayUrl = "http://relay:8787";
  # relay/ and the one file of lib/e2ee it reaches for, laid out as in the
  # repo so its ../../lib/e2ee/wire resolves.
  relaySrc = pkgs.lib.fileset.toSource {
    root = src;
    fileset = pkgs.lib.fileset.unions [ (src + "/relay/src") (src + "/relay/wrangler.jsonc") (src + "/lib/e2ee/wire.ts") ];
  };

  # The bridge as the node's user, with its state under /var/lib/cb: every
  # command the test runs and the service alike. Forgejo won't run as root.
  cb = pkgs.writeShellScriptBin "cb" ''
    export HOME=/var/lib/cb CORKBOARD_STATE_DIR=/var/lib/cb/state CORKBOARD_DATA_DIR=/var/lib/cb/data
    export CORKBOARD_CACHE_DIR=/var/lib/cb/cache XDG_CONFIG_HOME=/var/lib/cb/config CORKBOARD_CLOUD=${relayUrl}
    export CORKBOARD_FORGEJO=${pkgs.lib.getExe pkgs.forgejo}
    # Episodes handed over at once, not after half an hour's quiet.
    export CORKBOARD_CONSOLIDATE_QUIET_MS=0 CORKBOARD_CONSOLIDATE_EVERY_MS=2000
    if [ "$(${pkgs.coreutils}/bin/id -u)" = 0 ]; then exec ${pkgs.util-linux}/bin/runuser -u cb -- ${pkgs.lib.getExe corkboard} "$@"; fi
    exec ${pkgs.lib.getExe corkboard} "$@"
  '';

  # serveArgs: what this node is given beyond the index.
  node = serveArgs: { ... }: {
    virtualisation.memorySize = 1536;
    virtualisation.cores = 2;
    users.users.cb = { isSystemUser = true; group = "cb"; home = "/var/lib/cb"; createHome = true; };
    users.groups.cb = { };
    environment.systemPackages = [ cb pkgs.curl pkgs.jq pkgs.git ];
    # Started by the test, once the account is on this machine.
    systemd.services.corkboard-node = {
      path = [ pkgs.git ];
      serviceConfig = {
        User = "cb";
        ExecStart = "${cb}/bin/cb serve --port 8787 --host 127.0.0.1 ${serveArgs}";
        Restart = "on-failure";
      };
    };
  };
in
pkgs.testers.runNixOSTest {
  name = "corkboard-multi-node";

  nodes = {
    relay = { ... }: {
      virtualisation.memorySize = 1536;
      virtualisation.cores = 2;
      networking.firewall.allowedTCPPorts = [ 8787 ];
      systemd.services.relay = {
        wantedBy = [ "multi-user.target" ];
        environment = { WRANGLER_SEND_METRICS = "false"; HOME = "/var/lib/relay"; };
        # wrangler writes .wrangler/ beside the config, so a copy it can write to.
        preStart = ''
          rm -rf /var/lib/relay/src
          cp -r ${relaySrc} /var/lib/relay/src
          chmod -R u+w /var/lib/relay/src
        '';
        serviceConfig = {
          StateDirectory = "relay";
          WorkingDirectory = "/var/lib/relay";
          ExecStart = "${pkgs.lib.getExe pkgs.wrangler} dev --config /var/lib/relay/src/relay/wrangler.jsonc --local --ip 0.0.0.0 --port 8787 --var ORIGIN:${relayUrl} --var RELAY_INVITE:test --persist-to /var/lib/relay/state";
        };
      };
    };
    # alpha keeps the brain from the start; beta and gamma take what the
    # index lists, so they find the board and the brain alpha makes.
    alpha = node "--brain work";
    beta = node "";
    gamma = node "";
  };

  testScript = ''
    import json, re, shlex

    nodes = [alpha, beta, gamma]
    tokens = {}

    def api(m, method, path, body=None):
        data = f"-H 'Content-Type: application/json' -d {shlex.quote(json.dumps(body))}" if body is not None else ""
        out = m.succeed(f"curl -sf -X {method} -H 'Authorization: Bearer {tokens[m.name]}' {data} http://127.0.0.1:8787{path}")
        return json.loads(out) if out.strip() else None

    def found(pattern, text):
        m = re.search(pattern, text)
        assert m, f"no {pattern} in {text}"
        return m.group(1)

    def eventually(m, path, test, what):
        def ok(_):
            try:
                return test(api(m, "GET", path))
            except Exception:
                return False
        retry(ok, timeout_seconds=60)
        m.log(f"{m.name} has {what}")

    start_all()
    relay.wait_for_unit("relay.service")
    relay.wait_until_succeeds("curl -sf http://127.0.0.1:8787/health", timeout=120)
    for m in nodes:
        m.wait_for_unit("multi-user.target")
        m.succeed("curl -sf ${relayUrl}/health")

    with subtest("alpha makes the account, beta recovers it, gamma pairs"):
        out = alpha.succeed("cb e2ee init --invite test --name alpha")
        phrase = "\n".join(re.findall(r"\d+\. ([a-z]+)", out))
        assert len(phrase.split()) == 24, out
        beta.succeed(f"printf '%s\\n\\n\\n' {shlex.quote(phrase)} | cb e2ee recover --name beta")
        # A unit of its own, so the joiner outlives the shell that starts it.
        gamma.succeed("systemd-run --unit=pair -p StandardOutput=file:/tmp/pair.log sh -c 'echo y | ${cb}/bin/cb e2ee pair --name gamma; echo $? > /tmp/pair.rc'")
        code = gamma.wait_until_succeeds("grep -oE '^  [0-9A-Za-z]{5}-[0-9A-Za-z]{5}$' /tmp/pair.log", timeout=60).strip()
        approved = alpha.succeed(f"echo y | cb e2ee approve {code}")
        gamma.wait_until_succeeds("grep -qx 0 /tmp/pair.rc", timeout=60)
        # Both sides were shown the same six digits.
        sas = found(r"Does it show (\S+)\?", approved)
        gamma.succeed(f"grep -qF 'Is it {sas}?' /tmp/pair.log")
        for m in nodes:
            out = m.succeed("cb e2ee status")
            assert "signed in" in out, f"{m.name}: {out}"

    with subtest("the nodes start"):
        for m in nodes:
            tokens[m.name] = m.succeed("cb serve token --scope owner --name test | tail -1").strip()
            m.systemctl("start corkboard-node")
        for m in nodes:
            m.wait_until_succeeds("curl -sf http://127.0.0.1:8787/health", timeout=120)
        alpha.wait_until_succeeds("[ $(cb e2ee nodes | grep -c '^connected') = 3 ]", timeout=60)

    with subtest("a card made on alpha reaches beta and gamma"):
        api(alpha, "PUT", "/api/node/boards/test", {"name": "Test"})
        card = api(alpha, "POST", "/api/node/boards/test/cards", {"title": "crosses over"})
        for m in [beta, gamma]:
            eventually(m, "/api/node/boards/test/cards", lambda cs: any(c["id"] == card["id"] for c in cs), "the card")

    with subtest("a change on gamma reaches alpha"):
        api(gamma, "PATCH", f"/api/node/boards/test/cards/{card['id']}", {"status": "doing"})
        eventually(alpha, f"/api/node/boards/test/cards/{card['id']}", lambda c: c["status"] == "doing", "gamma's change")

    with subtest("a brain's note crosses"):
        api(alpha, "PUT", "/api/node/brains/work/notes/hello", {"kind": "reference", "title": "Hello", "body": "from alpha"})
        for m in [beta, gamma]:
            eventually(m, "/api/node/brains/work/notes/hello", lambda n: n["body"] == "from alpha", "the note")

    with subtest("alpha leads, and runs the forge alone"):
        alpha.succeed("cb e2ee leader this")
        alpha_id = found(r"connected alpha (\S+)", alpha.succeed("cb e2ee nodes"))
        for m in [beta, gamma]:
            m.wait_until_succeeds(f"cb e2ee nodes | grep '^leader' | grep -F {alpha_id}", timeout=30)
        alpha.wait_until_succeeds("pgrep -u cb -f 'forgejo.* web --config'", timeout=120)
        for m in [beta, gamma]:
            m.wait_until_fails("pgrep -u cb -f 'forgejo.* web --config'", timeout=60)

    with subtest("an episode posted on beta is handed to the leader"):
        # A Claude Code transcript, as a session's hooks send one: one that reads as nothing isn't handed over.
        said = [("user", "2026-11-20T10:00:00Z", "hi"), ("assistant", "2026-11-20T10:00:01Z", "hello")]
        transcript = "\n".join(json.dumps({"type": t, "timestamp": at, "message": {"content": c}}) for t, at, c in said)
        api(beta, "POST", "/memory/episodes?brain=work", {"session": "s-beta", "transcript": transcript})
        def handed(_):
            out = alpha.succeed(f"curl -sf -H 'Authorization: Bearer {tokens['alpha']}' 'http://127.0.0.1:8787/memory/episodes?brain=work'")
            return "s-beta" in out
        retry(handed, timeout_seconds=180)

    with subtest("alpha dies, and the leadership and the forge move"):
        alpha.crash()
        try:
            beta.wait_until_succeeds("[ $(cb e2ee nodes | grep -c '^connected') = 2 ]", timeout=120)
        except Exception:
            print(beta.succeed("cb e2ee nodes; date -u"))
            raise
        beta.succeed("cb e2ee leader this")
        beta.wait_until_succeeds("pgrep -u cb -f 'forgejo.* web --config'", timeout=120)
        gamma.fail("pgrep -u cb -f 'forgejo.* web --config'")
        card2 = api(beta, "POST", "/api/node/boards/test/cards", {"title": "after alpha"})
        eventually(gamma, "/api/node/boards/test/cards", lambda cs: any(c["id"] == card2["id"] for c in cs), "the card made after alpha")
  '';
}
