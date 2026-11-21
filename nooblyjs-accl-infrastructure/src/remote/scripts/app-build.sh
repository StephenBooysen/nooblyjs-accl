#!/usr/bin/env bash
# Builds an app's image from the clone of this deploy (architecture.md §9 "Deploy"). Docker's output goes to stdout as
# it comes, so the operation log shows the build live; the last line is JSON. The clone is removed afterwards.
# Args: <app> <deploy id> <Dockerfile path> <build context> <image tag>
set -uo pipefail
app="${1:-}"; deploy="${2:-}"; dockerfile="${3:-}"; context="${4:-}"; tag="${5:-}"
fail() { printf '{"ok":false,"message":"%s"}\n' "$1"; exit "${2:-2}"; }
path_ok() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$1" != -* ]] && [[ "$1" != /* ]] && [[ "/$1/" != */../* ]]; }
[[ "$app" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fail 'Not an app name.'
[[ "$deploy" =~ ^[a-z]{2,8}_[a-z0-9]{4,32}$ ]] || fail 'Not a deploy id.'
path_ok "$dockerfile" || fail 'Not a Dockerfile path.'
path_ok "$context" || fail 'Not a build context.'
[[ "$tag" =~ ^noobly-app/[a-z0-9-]+:[a-z0-9_]{4,40}$ ]] || fail 'Not an image tag.'
dir="/srv/apps/$app/src/$deploy"
[ -d "$dir" ] || fail 'The source is not there: clone it first.'
cd "$dir" || fail 'The source is not there.'
[ -f "$dockerfile" ] || { rm -rf "$dir"; fail "There is no $dockerfile in the repository." 3; }
docker build --progress=plain --label "noobly-app=$app" -f "$dockerfile" -t "$tag" "$context" 2>&1
status=$?
cd / && rm -rf "$dir"
[ "$status" -eq 0 ] || fail "The build failed (docker build exited with $status). The log above says where." 4
printf '{"ok":true,"image":"%s"}\n' "$tag"
