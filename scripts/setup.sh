#!/bin/sh
set -eu
if [ ! -e .env ]; then
  (umask 077; cp .env.example .env)
  echo 'Created .env from .env.example.'
fi
echo 'Warning: API/Slack keys may be empty. OpenCode requires OPENAI_API_KEY; RUNTIME=fake needs no key. Slack keys are optional.' >&2
mkdir -p data/workspaces data/deployments
