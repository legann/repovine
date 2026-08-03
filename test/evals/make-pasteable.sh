#!/usr/bin/env bash
# Emit a self-contained, pasteable eval prompt: shared preamble + the named card
# (header rubric + body). Use for cross-repo runs where the target repo has no cards.
#
#   ./make-pasteable.sh entrypoint-coverage              # to stdout
#   ./make-pasteable.sh entrypoint-coverage | pbcopy     # macOS clipboard
#   ./make-pasteable.sh entrypoint-coverage | xclip -selection clipboard   # Linux
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
id="${1:-}"

if [ -z "$id" ]; then
  echo "usage: make-pasteable.sh <card-id>" >&2
  echo "cards:" >&2
  for f in "$dir"/*.eval.md; do
    [ -e "$f" ] || continue
    b="$(basename "$f" .eval.md)"
    case "$b" in _*) continue ;; esac   # skip _TEMPLATE and other underscore files
    echo "  $b" >&2
  done
  exit 2
fi

card="$dir/${id}.eval.md"
if [ ! -f "$card" ]; then
  echo "no such card: ${id}.eval.md" >&2
  exit 1
fi

cat "$dir/_PREAMBLE.md"
printf '\n\n---\n\n'
cat "$card"
