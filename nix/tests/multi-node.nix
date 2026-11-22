# `nix build .#checks.x86_64-linux.multi-node`: one account across three
# nodes in VMs, through a relay in a fourth. alpha makes the account, beta
# recovers it from the phrase, gamma pairs with alpha's approval; then
# cards, brain notes and episodes go between them over the relay, the
# leader is named and Forgejo runs on it alone, and when it dies the
# leadership and the forge move on. Before it dies, gamma calls Pepper on
# it as the phone does (call-phone.ts), with what alpha's own Kokoro said
# (call-speech.ts): the node, the relay and the channel's protocol, not the
# phone's Kotlin.
#
# The relay is relay/ under nixpkgs' wrangler (its own workerd), as
# `wrangler dev --local`: no Cloudflare, no node_modules. Its ORIGIN is the
# URL the nodes use, http://relay:8787.
{ pkgs, corkboard, src }:
let
  relayUrl = "http://relay:8787";
  # relay/ and the files of lib it reaches for, laid out as in the
  # repo so its ../../lib/e2ee/wire resolves.
  relaySrc = pkgs.lib.fileset.toSource {
    root = src;
    fileset = pkgs.lib.fileset.unions [ (src + "/relay/src") (src + "/relay/wrangler.jsonc") (src + "/lib/e2ee/wire.ts") (src + "/lib/harden.ts") (src + "/lib/dict.ts") ];
  };

  # The bridge as the node's user, with its state under /var/lib/cb: every
  # command the test runs and the service alike. Forgejo won't run as root.
  # cb-bun: a script of the test's, as that user, beside it.
  asCb = name: exe: pkgs.writeShellScriptBin name ''
    export HOME=/var/lib/cb CORKBOARD_STATE_DIR=/var/lib/cb/state CORKBOARD_DATA_DIR=/var/lib/cb/data
    export CORKBOARD_CACHE_DIR=/var/lib/cb/cache XDG_CONFIG_HOME=/var/lib/cb/config CORKBOARD_CLOUD=${relayUrl}
    export CORKBOARD_FORGEJO=${pkgs.lib.getExe pkgs.forgejo}
    # Episodes handed over at once, not after half an hour's quiet.
    export CORKBOARD_CONSOLIDATE_QUIET_MS=0 CORKBOARD_CONSOLIDATE_EVERY_MS=2000
    if [ "$(${pkgs.coreutils}/bin/id -u)" = 0 ]; then exec ${pkgs.util-linux}/bin/runuser -u cb -- ${exe} "$@"; fi
    exec ${exe} "$@"
  '';
  cb = asCb "cb" (pkgs.lib.getExe corkboard);
  cbBun = asCb "cb-bun" (pkgs.lib.getExe pkgs.bun);
  share = "${corkboard}/share/corkboard";

  # The call's models, laid out as the bridge keeps them in its cache
  # (transcribe.ts, speech.ts), as the VMs can't download them.
  hf = repo: rev: file: hash: {
    name = "${repo}/${file}";
    path = pkgs.fetchurl { url = "https://huggingface.co/${repo}/resolve/${rev}/${file}"; inherit hash; };
  };
  kokoro = hf "onnx-community/Kokoro-82M-v1.0-ONNX" "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
  parakeet = hf "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8" "1ab9323565ddb038682214b292f588070a538ce2";
  models = pkgs.linkFarm "corkboard-call-models" [
    (kokoro "onnx/model_uint8.onnx" "sha256-Zgejl9d7hRQGVCC3wecyARf3qr/bRc4V8AUMWw/nWuo=")
    (kokoro "config.json" "sha256-3zS0+TCyNEfNTcQQ+r+0LrPyToA+bD+X1hj7NZOAo28=")
    (kokoro "tokenizer.json" "sha256-d6AsjhZEEymbS0xAOxT44OHBtyfbTUagnWMnuGEGCjQ=")
    (kokoro "tokenizer_config.json" "sha256-vhywZtbvawdLPxXmpt0hrIj/PNrt8yXwqu1obHD3XSA=")
    (hf "onnx-community/silero-vad" "e71cae966052b992a7eca6b17738916ce0eca4ec" "onnx/model.onnx" "sha256-pKBozWzx6oNVuEMnWVg4ynSOwpolvJH8gubCmczcWAg=")
    (parakeet "encoder.int8.onnx" "sha256-oysS0Xu7wwnQaG+7zCmHtem4Mzp9qD+msInwoqzWUas=")
    (parakeet "decoder.int8.onnx" "sha256-trtkljRXI3uQDklu6ZlLWSlFJkOfvMH+z3BbMaFca04=")
    (parakeet "joiner.int8.onnx" "sha256-eUYWQ2eUbn+fKaEiQHwyUraA266aUTQ+skiNBXw8Q9I=")
    (parakeet "tokens.txt" "sha256-7BgrcN1CETr/bFNyx1ysWMlSRD6yIyL1e71/U5d9SX0=")
  ];

  # serveArgs: what this node is given beyond the index; big: it hears and
  # speaks a call, with Parakeet and Kokoro.
  node = { serveArgs, big ? false }: { ... }: {
    virtualisation.memorySize = if big then 4096 else 1536;
    virtualisation.cores = if big then 4 else 2;
    users.users.cb = { isSystemUser = true; group = "cb"; home = "/var/lib/cb"; createHome = true; };
    users.groups.cb = { };
    environment.systemPackages = [ cb cbBun pkgs.curl pkgs.jq pkgs.git ];
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
    alpha = node { serveArgs = "--brain work"; big = true; };
    beta = node { serveArgs = ""; };
    gamma = node { serveArgs = ""; };
  };

  testScript = ''
    import json, re, shlex

    nodes = [alpha, beta, gamma]
    tokens = {}

    def api(m, method, path, body=None, token=None):
        data = f"-H 'Content-Type: application/json' -d {shlex.quote(json.dumps(body))}" if body is not None else ""
        out = m.succeed(f"curl -sf -X {method} -H 'Authorization: Bearer {token or tokens[m.name]}' {data} http://127.0.0.1:8787{path}")
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
    try:
        relay.wait_until_succeeds("curl -sf -m 10 http://127.0.0.1:8787/health", timeout=120)
    except Exception:
        print(relay.succeed("journalctl -u relay --no-pager | tail -60"))
        raise
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

    with subtest("gamma calls Pepper on alpha, as the phone does"):
        alpha.succeed("mkdir -p /var/lib/cb/cache/models /tmp/said && cp -rs ${models}/. /var/lib/cb/cache/models/ && chown -R cb:cb /var/lib/cb/cache /tmp/said")
        said = {
            "ask": "What's on my calendar today?",
            "over": "Hold on, wait a moment.",
            "no": "No.",
        }
        print(alpha.succeed("cb-bun ${./call-speech.ts} ${share} /tmp/said " + " ".join(shlex.quote(f"{k}={v}") for k, v in said.items())))
        gamma.succeed("mkdir -p /tmp/phone/in && chown -R cb:cb /tmp/phone")
        for k in said:
            alpha.copy_from_machine(f"/tmp/said/{k}.raw", "said")
            gamma.copy_from_host(str(alpha.out_dir / "said" / f"{k}.raw"), f"/tmp/phone/{k}.raw")
        gamma.succeed("chown -R cb:cb /tmp/phone")

        def phone(name, n):
            # In turn, and whole: moved in once it's written.
            gamma.succeed(f"cp /tmp/phone/{name}.raw /tmp/phone/in/.{n} && chown cb:cb /tmp/phone/in/.{n} && mv /tmp/phone/in/.{n} /tmp/phone/in/{n}-{name}.raw")

        def heard(test, what, timeout=180):
            def ok(_):
                out = gamma.succeed("cat /tmp/phone/out.ndjson 2>/dev/null || true")
                return any(test(json.loads(l)) for l in out.splitlines() if l.strip())
            try:
                retry(ok, timeout_seconds=timeout)
            except Exception:
                print(gamma.succeed("cat /tmp/phone/out.ndjson 2>/dev/null; cat /tmp/phone.log"))
                print(alpha.succeed("journalctl -u corkboard-node --no-pager | tail -50"))
                raise
            gamma.log(f"the phone has {what}")

        gamma.succeed("systemd-run --unit=phone -p StandardOutput=file:/tmp/phone.log -p StandardError=file:/tmp/phone.log ${cbBun}/bin/cb-bun ${./call-phone.ts} ${share} /tmp/phone")
        heard(lambda m: m.get("status") == 200, "an answer")

        # What's asked is heard, and is the user's in the chat, from the call.
        phone("ask", 1)
        heard(lambda m: m.get("type") == "heard" and "calendar" in m["text"].lower(), "what was asked", timeout=300)
        eventually(alpha, "/api/node/chat", lambda ms: any(m["who"] == "call" and "calendar" in m["text"].lower() for m in ms), "the call's message")

        # What Pepper says is said back.
        brain = api(alpha, "POST", "/api/node/grants", {"scope": "brain", "brain": "work", "agent": "pepper"})["token"]
        api(alpha, "POST", "/api/node/chat", {"text": "Nothing until three."}, token=brain)
        heard(lambda m: m.get("type") == "say" and m["rate"] == 24000 and m["audio"] > 0 and "three" in m["text"], "Pepper's answer said")

        # Talked over, it stops.
        long = " ".join(f"This is sentence number {n} of a long answer." for n in range(1, 13))
        api(alpha, "POST", "/api/node/chat", {"text": long}, token=brain)
        heard(lambda m: m.get("type") == "say" and "number 1 " in m["text"], "the long answer begun")
        phone("over", 2)
        heard(lambda m: m.get("type") == "stop", "a stop")

        # What a resident would do waits, and a no on the call refuses it.
        resident = api(alpha, "POST", "/api/node/grants", {"scope": "brain", "brain": "work", "agent": "pepper", "resident": True})["token"]
        rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "spawn_stop", "arguments": {"id": "sp1abc"}}}
        print(alpha.succeed(f"curl -sf -X POST -H 'Authorization: Bearer {resident}' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d {shlex.quote(json.dumps(rpc))} http://127.0.0.1:8787/mcp"))
        heard(lambda m: m.get("type") == "confirm" and "sp1abc" in m["what"], "the confirm")
        phone("no", 3)
        heard(lambda m: m.get("type") == "decided" and m["state"] == "refused", "it refused")
        assert api(alpha, "GET", "/api/node/confirms") == [], "still waiting"

        # Hung up, the call ends.
        gamma.succeed("touch /tmp/phone/in/4.end")
        heard(lambda m: m.get("closed"), "the call ended", timeout=60)

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
