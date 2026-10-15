#!/usr/bin/env bash
# Sets up this repo's personal Claude Code config on a machine. Safe to rerun.
#
#   scripts/bootstrap.sh                 # config + tasks-panel + statusline
#   scripts/bootstrap.sh lightning-ai    # config + the plugins named
#
# - merges config/settings.snippet.json into ~/.claude/settings.json
# - adds config/gitignore-global to git's global excludes file
# - adds this clone as the "agentic" marketplace and installs plugins
# - with statusline, points the statusLine setting at its script
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
SETTINGS=$CLAUDE_DIR/settings.json
STAMP=$(date +%Y%m%d%H%M%S)

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
mkdir -p "$CLAUDE_DIR"

# Settings: merge the snippet
[[ -f $SETTINGS ]] || echo '{}' >"$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak.$STAMP"
merged=$(jq --slurpfile s "$REPO/config/settings.snippet.json" '. * $s[0]' \
  "$SETTINGS")
if [[ $merged == "$(jq . "$SETTINGS")" ]]; then
  rm "$SETTINGS.bak.$STAMP"
else
  printf '%s\n' "$merged" >"$SETTINGS"
  echo "updated $SETTINGS (backup: settings.json.bak.$STAMP)"
fi

# Global git excludes
excludes=$(git config --global core.excludesFile || true)
excludes=${excludes:-${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore}
excludes=${excludes/#\~/$HOME}
mkdir -p "$(dirname "$excludes")"
touch "$excludes"
while IFS= read -r line; do
  [[ -z $line || $line == \#* ]] && continue
  grep -qxF "$line" "$excludes" || {
    printf '%s\n' "$line" >>"$excludes"
    echo "added $line to $excludes"
  }
done <"$REPO/config/gitignore-global"

# Marketplace and plugins
if ! claude plugin marketplace list 2>/dev/null | grep -q agentic; then
  claude plugin marketplace add "$REPO"
fi
plugins=("${@:-tasks-panel}")
(($#)) || plugins+=(statusline)
for plugin in "${plugins[@]}"; do
  claude plugin install "$plugin@agentic" --scope user
  if [[ $plugin == statusline ]]; then
    bash "$REPO/plugins/statusline/setup.sh" --apply
    # The link older versions of this script made
    link=$CLAUDE_DIR/statusline.sh
    [[ -L $link && $(readlink "$link") == "$REPO"/* ]] && rm "$link"
  fi
done
