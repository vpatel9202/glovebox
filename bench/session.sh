#!/bin/zsh
# Runs bench/run.mjs with the usage watcher beside it. If the watcher stops the
# run at the org spend cap, commits the results and pushes. See bench/README.md.
#
#   CYCLE_START=2026-10-10 bench/session.sh --model claude-sonnet-5-5 --n 3 --stop-after-rep 1 --budget 30
#
# ORG_CAP (default 90) and WATCH_MIN (default 5) adjust the watcher, RUNNER
# replaces run.mjs for tests, and DRY=1 prints the git and bd commands.
set -u
cd "${0:A:h}/.."
run() { if [[ -n "${DRY:-}" ]]; then echo "DRY: $*"; else "$@"; fi; }

mark=$(mktemp)
${=RUNNER:-node bench/run.mjs} "$@" &
runpid=$!

# A resumed file already exists, so take it from the arguments.
file=""
args=("$@")
for ((i = 1; i < ${#args[@]}; i++)); do
  [[ "${args[i]}" == "--resume" ]] && file="${args[i + 1]}"
done
for i in {1..120}; do
  [[ -n "$file" ]] && break
  file=$(find bench/results/raw -name '*.jsonl' -newer "$mark" 2>/dev/null | head -1)
  [[ -n "$file" ]] && break
  kill -0 $runpid 2>/dev/null || break
  sleep 5
done
rm -f "$mark"
if [[ -z "$file" ]]; then
  wait $runpid
  echo "SESSION: run exited before writing a results file (code $?)"
  exit 1
fi
echo "SESSION: results file $file"

node bench/usage.mjs --watch ${WATCH_MIN:-5} --file "$file" --pid $runpid --org-cap ${ORG_CAP:-90} --cycle-start "$CYCLE_START" &
watchpid=$!

wait $runpid
runcode=$?
# A cap stop signals the run first and exits right after; give it time.
for i in {1..20}; do
  kill -0 $watchpid 2>/dev/null || break
  sleep 0.5
done
if kill -0 $watchpid 2>/dev/null; then
  kill $watchpid
  watchcode=0
else
  wait $watchpid
  watchcode=$?
fi
echo "SESSION: run exit $runcode, watcher exit $watchcode"

if [[ $watchcode -eq 3 ]]; then
  echo "SESSION: org spend cap reached; committing and pushing results"
  run git add "$file"
  run git commit -q -m "bench: partial results, stopped at the org spend cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  run git push -u origin "$(git branch --show-current)"
  run bd dolt push
  echo "SESSION: CAP-STOP pushed; resume with --resume $file"
elif [[ $watchcode -eq 4 ]]; then
  echo "SESSION: WATCH-STOP usage drifted from the records or checks kept failing; nothing pushed"
else
  echo "SESSION: run finished on its own; nothing pushed"
fi
