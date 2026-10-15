#!/usr/bin/env bash
# Claude Code status line: model, context window, 5-hour and 7-day limits.
#   opus  ctx ●●●●○○ 124k/200k  5h ●○○○○○ 2h14m  7d ●●○○○○ 3d4h
# Reads the status-line JSON on stdin. Any part whose fields are missing or
# null is left out. If the line is wider than $COLUMNS, the limit bars move
# to a second line.

export LC_ALL=C.UTF-8 # so ${#s} counts characters, not bytes

GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' RESET=$'\e[0m'
MUTED=$'\e[90m'       # labels and "/max"
EMPTY=$'\e[38;5;238m' # empty dots
SEP="  "

# One jq call; fields separated by \x1f (non-whitespace, so empty fields
# survive `read`). Numbers are rounded; null/missing become "". A bar is
# "<filled dots>:<g|y|r>", worked out from the unrounded percentage.
IFS=$'\x1f' read -r model ctx_bar ctx_used ctx_max h5_bar h5_reset d7_bar \
    d7_reset < <(jq -r '
  def n: if type == "number" then (. + 0.5 | floor | tostring) else "" end;
  def bar: if type != "number" then ""
    else ((. * 6 / 100 + 0.5 | floor | [., 0] | max | [., 6] | min
           | tostring)
          + ":" + (if . >= 90 then "r" elif . >= 70 then "y" else "g" end))
    end;
  [ (.model.display_name // "" | tostring | ascii_downcase | split(" ")[0] // ""),
    (.context_window.used_percentage | bar),
    (.context_window.total_input_tokens | n),
    (.context_window.context_window_size | n),
    (.rate_limits.five_hour.used_percentage | bar),
    (.rate_limits.five_hour.resets_at | n),
    (.rate_limits.seven_day.used_percentage | bar),
    (.rate_limits.seven_day.resets_at | n)
  ] | join("\u001f")')

label() { printf '%s%s%s' "$MUTED" "$1" "$RESET"; }

bar() { # $1 = "<filled>:<g|y|r>" -> 6 dots: ● used, ○ free
  local filled=${1%%:*} color i out=""
  case ${1##*:} in
    r) color=$RED ;;
    y) color=$YELLOW ;;
    *) color=$GREEN ;;
  esac
  out+=$color
  for ((i = 0; i < filled; i++)); do out+="●"; done
  out+=$EMPTY
  for ((i = filled; i < 6; i++)); do out+="○"; done
  printf '%s%s' "$out" "$RESET"
}

tokens() { # 124000 -> 124k, 1000000 -> 1M, 1500000 -> 1.5M
  local n=$1
  if ((n >= 999500)); then # what rounds to 1000k shows as 1M
    local tenths=$(((n + 50000) / 100000))
    if ((tenths % 10 == 0)); then printf '%dM' $((tenths / 10))
    else printf '%d.%dM' $((tenths / 10)) $((tenths % 10)); fi
  else
    printf '%dk' $(((n + 500) / 1000))
  fi
}

time_left() { # $1 = reset epoch seconds
  local s=$(($1 - $(date +%s)))
  ((s < 0)) && s=0
  if ((s < 3600)); then printf '%dm' $((s / 60))
  elif ((s < 86400)); then printf '%dh%dm' $((s / 3600)) $((s % 3600 / 60))
  else printf '%dd%dh' $((s / 86400)) $((s % 86400 / 3600)); fi
}

limit() { # $1 = label, $2 = bar, $3 = reset epoch
  local out="$(label "$1") $(bar "$2")"
  [[ -n $3 ]] && out+=" $(time_left "$3")"
  printf '%s' "$out"
}

join() { # join non-empty args with SEP
  local out="" part
  for part in "$@"; do
    [[ -z $part ]] && continue
    [[ -n $out ]] && out+=$SEP
    out+=$part
  done
  printf '%s' "$out"
}

ctx_part="" h5_part="" d7_part=""
if [[ -n $ctx_bar ]]; then
  ctx_part="$(label ctx) $(bar "$ctx_bar")"
  [[ -n $ctx_used && -n $ctx_max ]] &&
    ctx_part+=" $(tokens "$ctx_used")$(label "/$(tokens "$ctx_max")")"
fi
[[ -n $h5_bar ]] && h5_part=$(limit 5h "$h5_bar" "$h5_reset")
[[ -n $d7_bar ]] && d7_part=$(limit 7d "$d7_bar" "$d7_reset")

line1=$(join "$model" "$ctx_part")
line2=$(join "$h5_part" "$d7_part")
full=$(join "$line1" "$line2")

visible=$(printf '%s' "$full" | sed 's/\x1b\[[0-9;]*m//g')
if [[ $COLUMNS =~ ^[0-9]+$ && ${#visible} -gt $COLUMNS && -n $line1 &&
  -n $line2 ]]; then
  printf '%s\n%s\n' "$line1" "$line2"
else
  printf '%s\n' "$full"
fi
