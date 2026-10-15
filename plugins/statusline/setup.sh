#!/usr/bin/env bash
# Points Claude Code's statusLine setting at this plugin's statusline.sh.
#
#   setup.sh            # print the settings diff, change nothing
#   setup.sh --apply    # write it (backup: settings.json.bak.<stamp>)
#   setup.sh --remove   # drop statusLine if it points at this script
#
# Plugins can't set statusLine themselves, and the installed copy sits in a
# version-keyed cache, so the setting points at the marketplace's copy
# instead: it moves with `/plugin marketplace update` and stays put.
set -euo pipefail

mode=${1:-diff}
case $mode in diff | --apply | --remove) ;; *)
  echo "usage: setup.sh [--apply | --remove]" >&2
  exit 2
  ;;
esac

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
SETTINGS=$CLAUDE_DIR/settings.json
KNOWN=$CLAUDE_DIR/plugins/known_marketplaces.json
REL=plugins/statusline/statusline.sh

# The first known marketplace holding this plugin, "agentic" preferred
script=""
if [[ -f $KNOWN ]]; then
  while IFS= read -r dir; do
    [[ -x $dir/$REL ]] && { script=$dir/$REL; break; }
  done < <(jq -r 'to_entries | sort_by(.key != "agentic")
    | .[].value.installLocation // empty' "$KNOWN")
fi
if [[ -z $script ]]; then
  echo "no marketplace with $REL found in $KNOWN;" \
    "add one first: /plugin marketplace add zweihuehner/agentic" >&2
  exit 1
fi

[[ -f $SETTINGS ]] || echo '{}' >"$SETTINGS"
if [[ $mode == --remove ]]; then
  new=$(jq --arg cmd "$script" \
    'if .statusLine.command == $cmd then del(.statusLine) else . end' \
    "$SETTINGS")
else
  new=$(jq --arg cmd "$script" \
    '.statusLine = {type: "command", command: $cmd, refreshInterval: 60}' \
    "$SETTINGS")
fi

if [[ $new == "$(jq . "$SETTINGS")" ]]; then
  echo "$SETTINGS is already up to date"
  exit 0
fi

diff -u --label "$SETTINGS" --label "$SETTINGS (new)" \
  <(jq . "$SETTINGS") <(printf '%s\n' "$new") || true

if [[ $mode == diff ]]; then
  echo "nothing written; rerun with --apply to save"
else
  stamp=$(date +%Y%m%d%H%M%S)
  cp "$SETTINGS" "$SETTINGS.bak.$stamp"
  printf '%s\n' "$new" >"$SETTINGS"
  echo "saved $SETTINGS (backup: settings.json.bak.$stamp)"
fi
