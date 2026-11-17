#!/bin/sh
# Start one managed Chromium lease. Chromium's own DevTools listener remains
# loopback-only; a Fabric-owned TCP bridge exposes it only on the container's
# primary private worker network for the manager and CDP gateway.
#
# `xvfb-run` waits for a SIGUSR1 readiness convention that is unreliable when
# the process is non-root, has no-new-privileges, and runs in Docker's reduced
# PID namespace. For an interactive lease this launcher owns exactly one local
# Xvfb process, waits for its Unix socket, and then waits for Chromium so the X
# server cannot outlive the browser lease. Headless leases use the same CDP
# bridge but do not start an unnecessary X server.
set -eu

if [ "$#" -lt 1 ]; then
  echo "fabric Chromium launcher requires a browser command" >&2
  exit 64
fi

readonly display_number=99
readonly display_socket_dir=/tmp/.X11-unix
readonly display_socket="$display_socket_dir/X$display_number"
readonly chromium_cdp_port=9222
readonly cdp_bridge_port=9223
readonly cdp_bridge_ready_file=/tmp/fabric-cdp-bridge.ready
readonly durable_profile_dir=/fabric/profile/chromium
readonly ephemeral_profile_dir=/tmp/fabric-browser-profile

# Chromium's profile singleton uses hostname-bound symlinks/files. A forced
# container stop can leave those three coordination entries behind even though
# Fabric has already released the exclusive writer/interactive lease. The
# managed runtime has exactly one fixed profile directory; do not let a browser
# argument redirect cleanup elsewhere. Cookies, preferences, extensions,
# history, and every other profile file stay untouched. Headless leases with
# no durable profile use the fixed tmpfs directory and have no persistent
# singleton state to recover.
profile_dir=
durable_profile=false
profile_argument_count=0
debug_port_argument_count=0
debug_address_argument_count=0
headless_browser=false
for argument in "$@"; do
  case "$argument" in
    --user-data-dir=*)
      profile_dir=${argument#--user-data-dir=}
      case "$profile_dir" in
        "$durable_profile_dir") durable_profile=true ;;
        "$ephemeral_profile_dir") durable_profile=false ;;
        *)
          echo "Fabric Chromium launcher received an unsafe profile path" >&2
          exit 64
          ;;
      esac
      profile_argument_count=$((profile_argument_count + 1))
      ;;
    --remote-debugging-port=*)
      if [ "$argument" != "--remote-debugging-port=$chromium_cdp_port" ]; then
        echo "Fabric Chromium launcher received an unsafe DevTools port" >&2
        exit 64
      fi
      debug_port_argument_count=$((debug_port_argument_count + 1))
      ;;
    --remote-debugging-address=*)
      if [ "$argument" != "--remote-debugging-address=127.0.0.1" ]; then
        echo "Fabric Chromium launcher requires a loopback DevTools address" >&2
        exit 64
      fi
      debug_address_argument_count=$((debug_address_argument_count + 1))
      ;;
    --headless|--headless=*)
      headless_browser=true
      ;;
  esac
done
if [ "$profile_argument_count" -ne 1 ]; then
  echo "Fabric Chromium launcher requires exactly one Fabric-owned profile path" >&2
  exit 64
fi
if [ "$debug_port_argument_count" -ne 1 ] || [ "$debug_address_argument_count" -ne 1 ]; then
  echo "Fabric Chromium launcher requires exactly one loopback DevTools listener" >&2
  exit 64
fi

if [ "$durable_profile" = true ]; then
  if [ ! -d /fabric/profile ] || [ -L /fabric/profile ]; then
    echo "Fabric Chromium launcher cannot use the Fabric profile mount" >&2
    exit 70
  fi
  if [ -e "$profile_dir" ] && { [ ! -d "$profile_dir" ] || [ -L "$profile_dir" ]; }; then
    echo "Fabric Chromium launcher refuses a non-directory profile path" >&2
    exit 70
  fi
  if [ ! -d "$profile_dir" ]; then
    mkdir "$profile_dir"
  fi
  for singleton in SingletonLock SingletonSocket SingletonCookie; do
    if [ -d "$profile_dir/$singleton" ] && [ ! -L "$profile_dir/$singleton" ]; then
      echo "Fabric Chromium launcher refuses an invalid Chromium singleton entry" >&2
      exit 70
    fi
  done
  rm -f -- "$profile_dir/SingletonLock" "$profile_dir/SingletonSocket" "$profile_dir/SingletonCookie"
else
  if [ -e "$profile_dir" ] && { [ ! -d "$profile_dir" ] || [ -L "$profile_dir" ]; }; then
    echo "Fabric Chromium launcher refuses a non-directory ephemeral profile path" >&2
    exit 70
  fi
  if [ ! -d "$profile_dir" ]; then
    mkdir "$profile_dir"
  fi
fi

xvfb_pid=
cdp_bridge_pid=
browser_pid=
cleanup() {
  trap - EXIT INT TERM
  for pid in "$browser_pid" "$cdp_bridge_pid" "$xvfb_pid"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "$browser_pid" "$cdp_bridge_pid" "$xvfb_pid"; do
    if [ -n "$pid" ]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

# The bridge has one fixed loopback upstream and accepts only Chromium's
# version endpoint plus browser-level CDP WebSockets. It rewrites the upstream
# Host header to loopback because Chromium rejects Docker lease hostnames.
# It has no host port, credentials, or control-plane network and exits with
# this lease container.
rm -f -- "$cdp_bridge_ready_file"
FABRIC_CDP_BRIDGE_PEER_HOST=fabric-cdp-gateway \
FABRIC_CDP_BRIDGE_PORT="$cdp_bridge_port" \
FABRIC_CHROMIUM_CDP_PORT="$chromium_cdp_port" \
  /usr/local/bin/bun /app/apps/cdp-private-bridge/src/server.ts &
cdp_bridge_pid=$!
bridge_ready=false
# Up to ten seconds: slow or emulated hosts start the X server and bridge well beyond one.
attempt=0
while [ "$attempt" -lt 200 ]; do
  attempt=$((attempt + 1))
  if [ -s "$cdp_bridge_ready_file" ]; then
    cdp_bridge_bind_address=$(tr -d '\r\n' < "$cdp_bridge_ready_file")
    case "$cdp_bridge_bind_address" in
      ''|127.*|*[!0-9.]*)
        echo "Fabric Chromium launcher received an invalid private CDP bridge address" >&2
        exit 70
        ;;
    esac
    if FABRIC_CDP_BRIDGE_HEALTH_URL="http://${cdp_bridge_bind_address}:${cdp_bridge_port}/healthz" \
      /usr/local/bin/bun -e 'const response = await fetch(process.env.FABRIC_CDP_BRIDGE_HEALTH_URL!); if (!response.ok) process.exit(1)' >/dev/null 2>&1; then
      bridge_ready=true
      break
    fi
  fi
  if ! kill -0 "$cdp_bridge_pid" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if [ "$bridge_ready" != true ]; then
  echo "Fabric Chromium launcher could not start its private CDP bridge" >&2
  exit 70
fi

if [ "$headless_browser" = true ]; then
  # Headless Chromium names itself "HeadlessChrome" in its User-Agent, and
  # Cloudflare's managed challenge serves the interstitial on that token alone
  # (a headed or UA-corrected browser on the same IP loads the page). Present the
  # ordinary Chrome UA of the exact installed major version, unless the caller
  # already chose one. A failed version probe leaves Chromium's default in place.
  user_agent_argument=
  caller_user_agent=false
  for argument in "$@"; do
    case "$argument" in
      --user-agent=*) caller_user_agent=true ;;
    esac
  done
  if [ "$caller_user_agent" = false ]; then
    chrome_major=$("$1" --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\..*/\1/p' | head -n 1 || true)
    case "$chrome_major" in
      ''|*[!0-9]*) echo "Fabric Chromium launcher could not read the Chromium version; keeping its default User-Agent" >&2 ;;
      *) user_agent_argument="--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome_major}.0.0.0 Safari/537.36" ;;
    esac
  fi
  XDG_RUNTIME_DIR=/tmp "$@" ${user_agent_argument:+"$user_agent_argument"} &
  browser_pid=$!
  wait "$browser_pid"
  exit $?
fi

if [ ! -d "$display_socket_dir" ]; then
  mkdir -m 1777 "$display_socket_dir"
fi
if [ ! -d "$display_socket_dir" ] || [ ! -w "$display_socket_dir" ]; then
  echo "Fabric Chromium launcher cannot use the private X socket directory" >&2
  exit 70
fi

Xvfb ":$display_number" -screen 0 1440x1024x24 -nolisten tcp &
xvfb_pid=$!

ready=false
# Up to ten seconds: slow or emulated hosts start the X server and bridge well beyond one.
attempt=0
while [ "$attempt" -lt 200 ]; do
  attempt=$((attempt + 1))
  if [ -S "$display_socket" ]; then
    ready=true
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "Fabric private X server exited before becoming ready" >&2
    exit 70
  fi
  sleep 0.05
done
if [ "$ready" != true ]; then
  echo "Fabric private X server did not become ready" >&2
  exit 70
fi

DISPLAY=":$display_number" XDG_RUNTIME_DIR=/tmp "$@" &
browser_pid=$!
wait "$browser_pid"
