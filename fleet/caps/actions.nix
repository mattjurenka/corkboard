# The `actions` capability's guest half: one Forgejo Actions job, run by
# forgejo-runner in host mode, then off. fleetd registers an ephemeral
# runner for the job (fleet/fleetd/actions.ts) and puts it in the share:
#
#   /mnt/share/job           "actions"
#   /mnt/share/actions.json  { url, uuid, handle, labels }
#   /mnt/share/runner-token  the ephemeral runner's token, good for this
#                            one job, which Forgejo forgets once it's run
#
# The job's steps run as claude in this VM, with the tools here and nix to
# bring more; nothing outlives the disk, which the next spawn gets fresh.
{ pkgs, lib, ... }:
let
  config = (pkgs.formats.yaml { }).generate "forgejo-runner.yaml" {
    log.level = "info";
    runner = { capacity = 1; timeout = "3h"; };
    # actions/cache's server, which nothing keeps between VMs.
    cache.enabled = false;
    host.workdir_parent = "/home/claude/.cache/act";
  };

  job = pkgs.writeShellApplication {
    name = "fleet-actions-job";
    runtimeInputs = [ pkgs.forgejo-runner pkgs.jq pkgs.coreutils ];
    text = ''
      out=$1
      a=/mnt/share/actions.json
      labels=()
      while read -r l; do labels+=(--label "$l:host"); done < <(jq -r '.labels[]' "$a")
      status=0
      forgejo-runner one-job -c ${config} \
        --url "$(jq -r .url "$a")" \
        --uuid "$(jq -r .uuid "$a")" \
        --token-url file:///mnt/share/runner-token \
        --handle "$(jq -r .handle "$a")" \
        "''${labels[@]}" > "$out/runner.log" 2>&1 || status=$?
      jq -n --arg log "$(tail -c 4000 "$out/runner.log")" '{ result: $log }' > "$out/result.json"
      exit "$status"
    '';
  };
in
{
  environment.systemPackages = [ job ] ++ (with pkgs; [
    bash
    git
    nodejs
    curl
    jq
    gnumake
    gcc
    gnutar
    gzip
    xz
  ]);
}
