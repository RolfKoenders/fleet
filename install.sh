#!/bin/sh
# Installs fleet for this user: clones the tool and links `fleet` into ~/.local/bin.
# It uses no sudo and installs nothing else. Running it again changes nothing.
#
#   curl -fsSL https://raw.githubusercontent.com/RolfKoenders/fleet/main/install.sh | sh

# Everything is in a function, so a download cut off halfway runs nothing.
main() {
  set -eu
  repo=${FLEET_INSTALL_REPO:-https://github.com/RolfKoenders/fleet.git}
  tool="$HOME/.local/share/fleet/fleet"
  link="$HOME/.local/bin/fleet"

  command -v git >/dev/null 2>&1 || stop "git is not installed; install it, then run this again"

  # The same search as bin/fleet, which is not here yet.
  found_node=
  for node in \
    "${FLEET_NODE:-}" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/.local/bin/node" \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /opt/homebrew/opt/node@22/bin/node \
    /usr/local/opt/node@22/bin/node
  do
    if [ -n "$node" ] && [ -x "$node" ] && "$node" -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null; then
      found_node=$node
      break
    fi
  done
  [ -n "$found_node" ] || stop "fleet needs Node 22.18 or newer; install it, then run this again"

  # A link anywhere else is someone's own fleet, so check before cloning anything.
  if [ -e "$link" ] || [ -L "$link" ]; then
    [ "$(readlink -f "$link")" = "$(readlink -f "$tool/bin/fleet")" ] ||
      stop "$link already exists and points somewhere else; move it away, then run this again"
  fi

  if [ -d "$tool/.git" ]; then
    echo "fleet is already in $tool"
  elif [ -e "$tool" ]; then
    stop "$tool exists and is not a git clone; move it away, then run this again"
  else
    mkdir -p "$(dirname "$tool")"
    git clone --quiet -- "$repo" "$tool" || stop "could not clone $repo"
    echo "Cloned fleet into $tool"
  fi

  if [ ! -L "$link" ]; then
    mkdir -p "$(dirname "$link")"
    ln -s "$tool/bin/fleet" "$link"
    echo "Linked $link"
  fi

  # On macOS, `brew install sops age` brings both.
  command -v sops >/dev/null 2>&1 || [ -x "$HOME/.local/bin/sops" ] || [ -x /opt/homebrew/bin/sops ] ||
    echo "You still need sops 3.11 or newer: https://github.com/getsops/sops (macOS: brew install sops)"
  command -v age-keygen >/dev/null 2>&1 || [ -x "$HOME/.local/bin/age-keygen" ] || [ -x /opt/homebrew/bin/age-keygen ] ||
    echo "You still need age: https://github.com/FiloSottile/age (macOS: brew install age)"

  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "Add ~/.local/bin to your PATH to run fleet" ;;
  esac

  echo
  echo "Next, create your config:"
  echo "  fleet new ~/fleet-config"
}

stop() {
  echo "fleet: $1" >&2
  exit 1
}

main
