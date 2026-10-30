# Pepper's VM on the droplet: one Claude Code session, in tmux, always
# running, as the guest's `claude`. The droplet's half (fleet/pepper/pepper.nix)
# boots it, gives it its egress proxy, and reaches it over ssh from the
# gateway: corkboard-pepperd to write its corkboard token and paste in the
# phone's chat, and the day plan's window to attach.
#
# As pepper-vm on the laptop (~/nixosconfig/modules/hosts/pepper-vm): no
# shares, no route and no resolver, only the proxy, which knows the pepper
# brain's allowlist. Its code and settings are this closure, so Pepper can't
# edit its own instructions. What it keeps between boots (the Claude token,
# ~/.claude, the corkboard token) is on its disk.
{ plan, memoryHooks }:
{ config, pkgs, lib, modulesPath, ... }:
let
  vm = plan;
  tokenFile = "/var/lib/pepper/corkboard-token";
  socket = "/run/pepper/tmux.sock";
  # The Claude account's OAuth token (`claude setup-token`), the personal
  # account's, as the pepper brain names. Copied in by hand.
  claudeToken = "/home/claude/.config/claude-token";

  proxyUrl = "http://${vm.hostAddress}:${toString vm.proxyPort}";
  proxyEnv = {
    HTTP_PROXY = proxyUrl;
    HTTPS_PROXY = proxyUrl;
    http_proxy = proxyUrl;
    https_proxy = proxyUrl;
    NO_PROXY = "localhost,127.0.0.1";
    no_proxy = "localhost,127.0.0.1";
  };

  claudeCodeEnv = {
    # The account's claude.ai connectors include Google Calendar with write,
    # and only the user accepts a day plan.
    ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    CLAUDE_CODE_DISABLE_ARTIFACT = "1";
    # Hosts that aren't on the allowlist.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    # Nix owns the binary.
    DISABLE_AUTOUPDATER = "1";
  };

  env = proxyEnv // claudeCodeEnv;

  headers = pkgs.writeShellApplication {
    name = "pepper-corkboard-headers";
    runtimeInputs = [ pkgs.jq ];
    text = ''
      if [ -s ${tokenFile} ]; then
        jq -cn --rawfile t ${tokenFile} '{ Authorization: ("Bearer " + ($t | rtrimstr("\n"))) }'
      else
        echo '{}'
      fi
    '';
  };

  managedSettings = {
    env = claudeCodeEnv;
    # Phone messages arrive with no one at the terminal to approve a call.
    permissions.allow = [ "mcp__corkboard" ];
    inherit (memoryHooks { inherit pkgs lib tokenFile; }) hooks;
  };

  managedMcp.mcpServers.corkboard = {
    type = "http";
    url = "https://portal.corkboard.fyi/mcp";
    headersHelper = lib.getExe headers;
  };

  prompt = ''
    You are Pepper, Matt's personal assistant: one Claude Code session that runs all the time on a server of your own, and the
    same session wherever Matt talks to you. None of his files are here.
    He talks to you two ways. In corkboard's day plan window, beside his plan for today, he types here and reads your answers here.
    From corkboard's phone app, his messages arrive as prompts that start with "[phone]": answer those with corkboard's chat_send,
    plain text (no markdown, short paragraphs), since he reads only the chat there. Your answer here isn't sent anywhere.
    In the morning his phone keeps his distracting apps locked until today's plan is accepted and he has meditated for 30 minutes.
    When he asks you to plan or re-plan the day, read today's plan with plan_read first (keep the ids of blocks you don't change;
    minutes since midnight), plan it as the plan-my-day skill would (if you have it), and call plan_propose instead of writing the
    calendar. He sees it as a diff in the plan window or on his phone, undoes what he doesn't want, and accepts it there, which
    writes the calendar; he may also say what to change, which plan_read returns as asked. You can't accept it for him, and he
    can't skip planning by asking you to.
    Your memory is corkboard's: the session starts with it (who you are, the last days' log, what you've learned), and a new
    session starts each day at 4am. When something happens, is decided or is learned, write it in today's log with
    memory_remember, a line that will make sense later. To find what you don't see, memory_recall (or memory_grep for exact
    words), then note_read. Keep lasting knowledge in notes (note_write; pass the version you read). Notes also hold Matt's
    goals: notes of kind goal, one per goal (why, how it's measured, this week's step). Only you see them; no other agent can,
    so don't copy them into cards or other notes.
    You don't do coding or project work yourself. When Matt asks for that kind of work, make a card for it on the project's
    board (list_boards for its key) with create_card: status ready, a description a session that knows nothing of this
    conversation can act on (what to do, why, and anything Matt told you about it), and attention set to one line saying what
    it's for, so corkboard notifies him. He starts the agent from the card. Then tell Matt the card's id and board.
  '';

  # Once a day, Pepper reads the token usage reports corkboard writes
  # (usage-<project> notes, from nvim/lua/corkboard/usage.lua) and keeps a
  # note of how to spend fewer tokens. Only corkboard's tools: in print mode
  # anything else is refused rather than asked.
  usageReviewPrompt = pkgs.writeText "pepper-usage-review-prompt" ''
    You are Pepper, Matt's personal assistant. Review his Claude Code token usage and suggest how to reduce it.

    1. Find the usage reports: note_search with kind review and the query "Token usage", then note_read each
       note whose id starts with usage- (one per project; usage-recommendations is yours, below).
    2. note_read usage-recommendations, if it exists: what you suggested before, and when.
    3. Decide on up to five recommendations, ranked by the weekly saving you estimate. Each cites the numbers
       it rests on (the session, the category, the item, the account and machine where they differ) and says
       what Matt would change: a CLAUDE.md rule, a habit (shorter sessions, /clear between tasks, a subagent
       for broad searches), a Claude Code setting, or a change to corkboard itself. Work out which earlier
       recommendations the numbers now show working, or not. Skip anything the numbers don't support.
    4. Only if a recommendation is new since the last note and would save more than about $10 a week:
       create one card for it on that project's board (list_boards; the board whose root is the report's
       path), titled "Usage: <what to change>", with attention set so Matt sees it, and the numbers in
       its description. At most one card a run, and none if an open card already has the same aim.
    5. note_write usage-recommendations (kind review, title "Token usage: recommendations"), replacing it.
       Start it with today's date, then the recommendations as brief markdown. End it with exactly one
       fenced ```json block, which corkboard's usage view draws the note from (the markdown is its
       fallback), in this shape:
         {"date": "YYYY-MM-DD",
          "recommendations": [{"title": "what to change, a short line",
                               "saving": 12.5,
                               "change": "what Matt would do (markdown)",
                               "evidence": "the numbers it rests on (markdown)",
                               "project": "/the/report's/path",
                               "cards": ["TASK-15"]}],
          "earlier": [{"title": "an earlier recommendation",
                       "status": "working" | "not working" | "too soon",
                       "evidence": "what the numbers show (markdown)"}]}
       saving is the estimated dollars a week, a number. cards are the ids of cards that are about the
       recommendation: the one you created in step 4, and any open card with the same aim. [] when none.
  '';

  # tmux only holds the session: no status line, no prefix key (Claude Code
  # wants every key, ^B included), and the attached window's size.
  tmuxConf = pkgs.writeText "pepper-tmux.conf" ''
    set -g status off
    set -g prefix None
    unbind -a
    set -g escape-time 0
    set -g mouse off
    set -g default-terminal tmux-256color
    set -ga terminal-features ",xterm*:RGB:extkeys"
    set -g extended-keys on
    set -g window-size latest
  '';

  tmux = "${lib.getExe pkgs.tmux} -S ${socket} -f ${tmuxConf}";

  withToken = name: text: pkgs.writeShellApplication {
    inherit name;
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      CLAUDE_CODE_OAUTH_TOKEN=$(tr -d '\n' < ${claudeToken})
      export CLAUDE_CODE_OAUTH_TOKEN
      # Not home itself: Claude Code never saves trusting it, and would ask
      # each new session.
      mkdir -p /home/claude/pepper
      cd /home/claude/pepper
      ${text}
    '';
  };

  session = withToken "pepper-session" ''
    exec ${lib.getExe pkgs.claude-code} --name Pepper --append-system-prompt "$(cat ${pkgs.writeText "pepper-prompt" prompt})"
  '';

  # Starting makes the session; stopping asks Claude Code to exit, so its
  # SessionEnd hook sends the day's transcript.
  start = pkgs.writeShellScript "pepper-start" ''
    ${tmux} new-session -d -s pepper -x 160 -y 48 ${lib.getExe session}
  '';
  stop = pkgs.writeShellScript "pepper-stop" ''
    ${tmux} has-session -t pepper 2>/dev/null || exit 0
    ${tmux} send-keys -t pepper Escape C-u
    ${tmux} send-keys -t pepper -l /exit
    ${tmux} send-keys -t pepper Enter
    for _ in $(seq 60); do
      ${tmux} has-session -t pepper 2>/dev/null || exit 0
      sleep 0.5
    done
    ${tmux} kill-server
  '';

  keys = import ./authorized-keys.nix;
in
{
  imports = [ "${modulesPath}/virtualisation/qemu-vm.nix" ];

  nixpkgs.hostPlatform = "x86_64-linux";
  # Claude Code is unfree.
  nixpkgs.config.allowUnfree = true;

  virtualisation = {
    # The closure as an image the launcher builds on every start, read-only:
    # Pepper runs what was built, and nothing else.
    useNixStoreImage = true;
    mountHostNixStore = false;
    writableStore = false;
    sharedDirectories = lib.mkForce { };

    diskImage = vm.diskImage;
    diskSize = 4096;
    memorySize = 1024;
    cores = 2;

    graphics = false;
    qemu.options = [
      "-serial mon:stdio"
      "-device virtio-serial-pci"
    ] ++ lib.concatMap
      (i: [
        "-chardev socket,id=${vm.consoleChardevId i},path=${vm.consoleSocketFor i},server=on,wait=off"
        "-device virtconsole,chardev=${vm.consoleChardevId i}"
      ])
      vm.consoleIndices;
    qemu.networkingOptions = lib.mkForce [
      "-netdev tap,id=net0,ifname=${vm.interface},script=no,downscript=no"
      "-device virtio-net-pci,netdev=net0,mac=${vm.mac}"
    ];
  };

  systemd.services = {
    pepper = {
      description = "Pepper: one Claude Code session, in tmux";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      unitConfig.ConditionPathExists = claudeToken;
      path = [ "/run/current-system/sw" ];
      serviceConfig = {
        Type = "forking";
        User = "claude";
        Group = "users";
        RuntimeDirectory = "pepper";
        RuntimeDirectoryMode = "0700";
        ExecStart = start;
        ExecStop = stop;
        Restart = "always";
        RestartSec = 5;
      };
    };

    # A new session each day, as the plan's day turns over.
    pepper-new-day = {
      description = "Pepper: a new session for the day";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.systemd}/bin/systemctl restart pepper.service";
      };
    };

    pepper-usage-review = {
      description = "Pepper's daily review of Claude Code token usage";
      path = [ "/run/current-system/sw" ];
      serviceConfig = {
        Type = "oneshot";
        User = "claude";
        Group = "users";
        ExecStart = lib.getExe (withToken "pepper-usage-review" ''
          exec ${lib.getExe pkgs.claude-code} -p "$(cat ${usageReviewPrompt})" --allowedTools mcp__corkboard
        '');
      };
    };

    pepper-console = {
      description = "Interactive console on ${vm.consoleDevice 1}";
      wantedBy = [ "multi-user.target" ];
      after = [ "dev-${vm.consoleDevice 1}.device" ];
      bindsTo = [ "dev-${vm.consoleDevice 1}.device" ];
      serviceConfig = {
        ExecStart = "${pkgs.bashInteractive}/bin/bash -il";
        User = "claude";
        Group = "users";
        WorkingDirectory = "/home/claude";
        StandardInput = "tty";
        StandardOutput = "tty";
        StandardError = "tty";
        Environment = [ "TERM=xterm-256color" ];
        TTYPath = "/dev/${vm.consoleDevice 1}";
        TTYReset = true;
        TTYVHangup = true;
        Restart = "always";
        RestartSec = "1s";
      };
      unitConfig.StartLimitIntervalSec = 0;
    };
    "serial-getty@${vm.consoleDevice 1}".enable = false;
  };

  systemd.timers = {
    pepper-new-day = {
      wantedBy = [ "timers.target" ];
      timerConfig.OnCalendar = "*-*-* 04:00:00";
    };
    pepper-usage-review = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "*-*-* 17:00";
        # A day the VM was off runs when it next boots.
        Persistent = true;
      };
    };
  };

  networking = {
    hostName = vm.name;
    usePredictableInterfaceNames = false;
    useDHCP = false;
    interfaces.eth0.ipv4.addresses = [{
      address = vm.guestAddress;
      prefixLength = vm.prefixLength;
    }];
    nameservers = lib.mkForce [ ];

    firewall.enable = true;
    firewall.extraCommands = ''
      iptables -I nixos-fw 1 -s ${vm.hostAddress} -j nixos-fw-accept
    '';
    firewall.extraStopCommands = ''
      iptables -D nixos-fw -s ${vm.hostAddress} -j nixos-fw-accept || true
    '';
  };

  services.openssh = {
    enable = true;
    listenAddresses = [{ addr = vm.guestAddress; port = 22; }];
    openFirewall = false;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  systemd.globalEnvironment = env;
  environment.sessionVariables = env;
  environment.etc."claude-code/managed-settings.json".text = builtins.toJSON managedSettings;
  environment.etc."claude-code/managed-mcp.json".text = builtins.toJSON managedMcp;

  # The corkboard token, written by pepperd over ssh.
  systemd.tmpfiles.rules = [ "d /var/lib/pepper 0700 claude users - -" ];

  users.mutableUsers = false;
  # No root or wheel login: the console (a shell as claude) is the way in.
  users.allowNoPasswordLogin = true;
  users.users.claude = {
    isNormalUser = true;
    description = "Pepper";
    group = "users";
    extraGroups = [ "systemd-journal" ];
    openssh.authorizedKeys.keys = [
      # corkboard-pepperd: the token, the phone's chat, and the host's
      # pepper-vm.service asking it to power off.
      "restrict ${keys.pepperd}"
      # The day plan's window, through the droplet's pepper user.
      ''command="${tmux} attach -t pepper",restrict,pty ${keys.attach}''
    ];
  };
  # So the host can stop it cleanly, the session's transcript sent.
  security.sudo.extraRules = [{
    users = [ "claude" ];
    commands = [{ command = "/run/current-system/sw/bin/systemctl poweroff"; options = [ "NOPASSWD" ]; }];
  }];

  environment.systemPackages = [ pkgs.curl pkgs.jq pkgs.tmux ];

  time.timeZone = "America/Phoenix";
  i18n.defaultLocale = "en_US.UTF-8";
  system.stateVersion = "26.11";
}
