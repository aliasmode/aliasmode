#!/bin/bash
# OS-level input for the gates on Linux/X11 (XTest through xdotool; no automation in the browser).
# Usage: DISPLAY=:N linux.sh <command> [args]
#   display-start N | display-stop N     rootless Xvfb 1920x1080x24 + openbox (refuses a display in use)
#   activate                             raise and focus the newest browser window
#   open <url>                           Ctrl+L, type the URL, Enter
#   type <text> | key <combo...> | click <x> <y>
#   copytext <out.txt> [xfrac yfrac]     click a blank point of the window, select all, copy, save the clipboard
#   shot <out.png> | geometry            screenshot | X Y WIDTH HEIGHT of the active window
. "${GATES_TOOLS:-$HOME/tools/gates}/env.sh"
cmd=$1; shift
win() { xdotool getactivewindow 2>/dev/null; }
case $cmd in
display-start)
  N=$1; run=${GATES_RUN:-/tmp/gates-run}; mkdir -p "$run"
  # A display that answers belongs to another run: refuse it, so no input reaches that run's browser.
  if DISPLAY=:$N xdpyinfo >/dev/null 2>&1; then echo "display :$N is in use" >&2; exit 1; fi
  rm -f /tmp/.X$N-lock /tmp/.X11-unix/X$N
  LD_PRELOAD=$XVFB_SHIM setsid nohup Xvfb ":$N" -screen 0 1920x1080x24 -nolisten tcp -xkbdir "$XKB_DIR" +extension GLX \
    >"$run/xvfb$N.log" 2>&1 </dev/null & echo $! >"$run/xvfb$N.pid"
  for _ in $(seq 50); do DISPLAY=:$N xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
  DISPLAY=:$N xdpyinfo >/dev/null 2>&1 || { echo "Xvfb :$N failed"; cat "$run/xvfb$N.log"; exit 1; }
  DISPLAY=:$N setsid nohup openbox >"$run/wm$N.log" 2>&1 </dev/null & echo $! >"$run/wm$N.pid"; sleep 1
  DISPLAY=:$N xsetroot -solid '#303030' 2>/dev/null
  echo "display :$N up";;
display-stop)
  N=$1; run=${GATES_RUN:-/tmp/gates-run}
  for f in wm$N xvfb$N; do [ -f "$run/$f.pid" ] && kill "$(cat "$run/$f.pid")" 2>/dev/null; rm -f "$run/$f.pid"; done
  sleep 0.5; rm -f /tmp/.X$N-lock /tmp/.X11-unix/X$N; echo "display :$N down";;
activate)
  w=$(xdotool search --onlyvisible --class 'chrom|firefox|aliasmode|navigator' 2>/dev/null | tail -1)
  [ -n "$w" ] && xdotool windowactivate --sync "$w" 2>/dev/null; xdotool windowfocus "$w" 2>/dev/null; echo "${w:-none}";;
open)
  w=$(win) && xdotool windowfocus "$w" 2>/dev/null; sleep 0.3
  xdotool key --clearmodifiers ctrl+l; sleep 0.5
  xdotool type --clearmodifiers --delay 40 -- "$1"; sleep 0.3
  xdotool key --clearmodifiers Return;;
type) xdotool type --clearmodifiers --delay 60 -- "$*";;
key) xdotool key --clearmodifiers "$@";;
click) xdotool mousemove "$1" "$2"; sleep 0.2; xdotool click 1;;
geometry)
  eval "$(xdotool getwindowgeometry --shell "$(win)" 2>/dev/null)"; echo "${X:-0} ${Y:-0} ${WIDTH:-1920} ${HEIGHT:-1080}";;
copytext)
  out=$1; eval "$(xdotool getwindowgeometry --shell "$(win)" 2>/dev/null)"
  X=${X:-0}; Y=${Y:-0}; WIDTH=${WIDTH:-1920}; HEIGHT=${HEIGHT:-1080}
  cx=$(awk -v x="$X" -v w="$WIDTH" -v f="${2:-0.004}" 'BEGIN{printf "%d", x + w*f + 2}')
  cy=$(awk -v y="$Y" -v h="$HEIGHT" -v f="${3:-0.7}" 'BEGIN{printf "%d", y + h*f}')
  printf '' | xclip -selection clipboard -i
  xdotool mousemove "$cx" "$cy"; sleep 0.2; xdotool click 1; sleep 0.3
  xdotool key --clearmodifiers ctrl+a; sleep 0.3
  xdotool key --clearmodifiers ctrl+c; sleep 0.7
  timeout 5 xclip -selection clipboard -o >"$out" 2>/dev/null || :
  xdotool click 1;;
shot)
  command -v ffmpeg >/dev/null && ffmpeg -loglevel error -y -f x11grab -video_size 1920x1080 -i "$DISPLAY" -frames:v 1 "$1";;
*) echo "unknown command $cmd" >&2; exit 2;;
esac
