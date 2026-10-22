#!/usr/bin/env bash
# Runs docs/tasks.md tasks unattended, one fresh `codex exec` per task.
# Usage: scripts/night-run.sh [first-task-number] [last-task-number]   (default 0 19)
# Logs: logs/night/T<n>.log   Results: docs/night-report.md on main
set -uo pipefail

FIRST="${1:-0}"
LAST="${2:-19}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
mkdir -p logs/night

# Keep the Mac awake for the whole run (re-exec under caffeinate once).
if [[ "$(uname)" == "Darwin" && -z "${YUNO_CAFFEINATED:-}" ]]; then
  export YUNO_CAFFEINATED=1
  exec caffeinate -dimsu "$0" "$@"
fi

fail() { echo "PREFLIGHT FAILED: $*" >&2; exit 1; }
command -v codex >/dev/null || fail "codex CLI not found"
command -v git >/dev/null || fail "git not found"
command -v node >/dev/null || fail "node not found"
command -v corepack >/dev/null || command -v pnpm >/dev/null || fail "pnpm/corepack not found"
docker info >/dev/null 2>&1 || echo "WARNING: Docker is not running; Docker checks (T14) will be NOT RUN"
command -v glab >/dev/null && glab auth status >/dev/null 2>&1 || echo "WARNING: glab missing or not logged in; merges will skip the pipeline check"
[[ -z "$(git status --porcelain)" ]] || fail "working tree not clean; commit or stash first"
[[ -f .env ]] && grep -q '^OPENAI_API_KEY=.\+' .env && echo "OPENAI_API_KEY is set: live spike/adapter checks will run" \
  || echo "NOTE: no OPENAI_API_KEY in .env; live checks will be skipped"

# Codex removed --full-auto in 2026; prefer explicit flags, fall back to the bypass flag.
if codex exec --help 2>/dev/null | grep -q -- '--ask-for-approval'; then
  CODEX_FLAGS=(--sandbox danger-full-access --ask-for-approval never)
else
  CODEX_FLAGS=(--dangerously-bypass-approvals-and-sandbox)
fi

task_done() {  # true if main's night report has "## T<n> ... DONE"
  git fetch -q origin main 2>/dev/null
  git show origin/main:docs/night-report.md 2>/dev/null | grep -Eq "^## T$1 .*DONE"
}

for ((n = FIRST; n <= LAST; n++)); do
  if task_done "$n"; then echo "T$n already done, skipping"; continue; fi
  for attempt in 1 2; do
    echo "=== T$n attempt $attempt  $(date '+%H:%M') ==="
    if [[ -n "$(git status --porcelain)" ]]; then
      git stash push -q -u -m "night-run: leftovers before T$n attempt $attempt"
      echo "Stashed uncommitted leftovers (see git stash list)"
    fi
    git checkout -q main && git pull -q --ff-only
    if [[ $attempt == 1 ]]; then
      PROMPT="Night mode. Do task T$n from docs/tasks.md, following AGENTS.md exactly: branch, tester, implement, verifier, reviewer, orchestration_auditor if applicable, commit, push, wait for a green pipeline, merge, then append your report to docs/night-report.md (it must be merged to main too). Do only T$n."
    else
      PROMPT="Night mode. A previous attempt at task T$n did not finish. Read logs/night/T$n.log (tail), git branches named codex/T$n-*, and docs/night-report.md, then finish T$n following AGENTS.md: get to VERIFIED, no blocking review issues, green pipeline, merged, report appended to docs/night-report.md on main. If it truly cannot be finished, merge what is safe, report it as PARTIAL or BLOCKED with the reason, and log questions in docs/questions.md. Do only T$n."
    fi
    codex exec "${CODEX_FLAGS[@]}" "$PROMPT" >>"logs/night/T$n.log" 2>&1
    if task_done "$n"; then echo "T$n DONE"; break; fi
    echo "T$n not marked DONE after attempt $attempt"
  done
  if [[ $n == 0 ]] && ! task_done 0; then
    echo "T0 (scaffold) failed; everything else depends on it. Stopping." >&2
    exit 1
  fi
done
echo "Night run finished $(date '+%H:%M'). See docs/night-report.md and docs/questions.md."
