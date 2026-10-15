#!/usr/bin/env bash
# Sets up this repo's personal Claude Code config on a machine. Safe to rerun.
#
#   scripts/bootstrap.sh                 # config + tasks-panel
#   scripts/bootstrap.sh lightning-ai    # config + the plugins named
#
# - links config/statusline.sh to ~/.claude/statusline.sh
# - merges config/settings.snippet.json into ~/.claude/settings.json
# - adds config/gitignore-global to git's global excludes file
# - adds this clone as the "agentic" marketplace and installs plugins
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
SETTINGS=$CLAUDE_DIR/settings.json
STAMP=$(date +%Y%m%d%H%M%S)

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
mkdir -p "$CLAUDE_DIR"

# Status line: a link, so edits in the repo apply at once
target=$CLAUDE_DIR/statusline.sh
if [[ -e $target && ! -L $target ]]; then
  mv "$target" "$target.bak.$STAMP"
  echo "moved existing statusline.sh to statusline.sh.bak.$STAMP"
fi
ln -sfn "$REPO/config/statusline.sh" "$target"

# Settings: merge the snippet, pointing statusLine at this machine's path
[[ -f $SETTINGS ]] || echo '{}' >"$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak.$STAMP"
merged=$(jq --arg cmd "$target" --slurpfile s "$REPO/config/settings.snippet.json" \
  '. * $s[0] | .statusLine.command = $cmd' "$SETTINGS")
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
for plugin in "${@:-tasks-panel}"; do
  claude plugin install "$plugin@agentic" --scope user
done
