# Task runner. Every recipe is a thin wrapper over script/* (Scripts to Rule
# Them All), so `just test` and `./script/test` are the same thing and the
# scripts remain the single source of truth — runnable with or without `just`.
set positional-arguments

# List available recipes
default:
    @just --list

# Install system toolchain (run once on a fresh machine)
bootstrap:
    ./script/bootstrap

# Get the project runnable (install deps)
setup:
    ./script/setup

# Refresh after pulling changes
update:
    ./script/update

# Show CLI help (requires build)
server:
    ./script/server

# Run the test suite (extra args pass through: `just test -k name`)
test *args:
    ./script/test "$@"

# What CI runs: install (frozen) + lint + test + build
cibuild:
    ./script/cibuild

# Open an interactive console / REPL
console:
    ./script/console
