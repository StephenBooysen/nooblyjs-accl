#!/usr/bin/env bash
# Clones one branch of an app's repository into /srv/apps/<app>/src/<deploy> (architecture.md §9 "Deploy"). A private
# repository's token was sent over SFTP to ~/.noobly/<token file>: a GIT_ASKPASS helper hands it to git, and both are
# removed when the clone ends, so the token is never on a command line, in the remote URL or in .git/config.
# Prints one JSON line: {"ok":true,"commit":"<sha>","message":"<subject>"}.
# Args: <app> <repository URL> <branch> <deploy id> <token file, or ->
set -uo pipefail
app="${1:-}"; repo="${2:-}"; branch="${3:-}"; deploy="${4:-}"; token_name="${5:--}"
fail() { printf '{"ok":false,"message":"%s"}\n' "$1"; exit "${2:-2}"; }
[[ "$app" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fail 'Not an app name.'
[[ "$deploy" =~ ^[a-z]{2,8}_[a-z0-9]{4,32}$ ]] || fail 'Not a deploy id.'
[[ "$repo" =~ ^(https://[A-Za-z0-9.-]+/|git@[A-Za-z0-9.-]+:)[A-Za-z0-9_./-]+$ ]] && [[ "$repo" != *..* ]] || fail 'Not a repository URL.'
git check-ref-format --branch "$branch" >/dev/null 2>&1 && [[ "$branch" != -* ]] || fail 'Not a branch name.'
askpass=""
token_file=""
cleanup() { [ -n "$askpass" ] && rm -f "$askpass"; [ -n "$token_file" ] && rm -f "$token_file"; }
trap cleanup EXIT
if [ "$token_name" != "-" ]; then
  [[ "$token_name" =~ ^[a-z0-9][a-z0-9._-]{0,200}$ ]] || fail 'Not a staged file.'
  token_file="$HOME/.noobly/$token_name"
  [ -f "$token_file" ] || fail 'The token did not arrive.'
  askpass=$(mktemp)
  chmod 0700 "$askpass"
  printf '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) cat %q ;; esac\n' "$token_file" > "$askpass"
  export GIT_ASKPASS="$askpass"
fi
export GIT_TERMINAL_PROMPT=0
sudo install -d -m 0750 -o noobly -g noobly "/srv/apps/$app" "/srv/apps/$app/src"
dir="/srv/apps/$app/src/$deploy"
rm -rf "$dir"
if ! out=$(git clone --quiet --depth 1 --single-branch --branch "$branch" -- "$repo" "$dir" 2>&1); then
  msg=$(printf '%s' "$out" | tail -n 1 | tr -d '"\\' | tr -cd '[:print:]' | cut -c1-300)
  fail "git clone failed: $msg" 3
fi
commit=$(git -C "$dir" rev-parse HEAD)
subject=$(git -C "$dir" log -1 --format=%s | tr -d '"\\' | tr -cd '[:print:]' | cut -c1-200)
printf '{"ok":true,"commit":"%s","message":"%s"}\n' "$commit" "$subject"
