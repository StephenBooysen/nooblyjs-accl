#!/usr/bin/env bash
# One app's containers (architecture.md §9): remove one, retire every other one, stop, start, read their state, read
# logs, prune old images, or delete everything of the app. Only containers labelled noobly-app=<app> are touched.
# Args: <action> <app> [<container> | <keep count> | <lines>]
#   remove <app> <container>      the container, now (a new one that failed its health check)
#   retire <app> <keep>           every container of the app but <keep>: stopped (30 s to finish requests), removed
#   stop|start <app> <container>
#   state <app>                   {"containers":[{"name","state","restarts","exitCode"}]}
#   logs <app> <container> <n>    the last n lines, raw
#   prune <app> <keep count>      images of the app not in use, all but the newest <keep count>
#   delete <app>                  containers, images and /srv/apps/<app>
set -uo pipefail
action="${1:-}"; app="${2:-}"; arg="${3:-}"; lines="${4:-200}"
fail() { printf '{"ok":false,"message":"%s"}\n' "$1"; exit "${2:-2}"; }
[[ "$app" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fail 'Not an app name.'
mine() { [ "$(docker inspect -f '{{index .Config.Labels "noobly-app"}}' "$1" 2>/dev/null)" = "$app" ]; }
ids() { docker ps -aq --filter "label=noobly-app=$app"; }
case "$action" in
  remove|stop|start)
    [[ "$arg" =~ ^[a-z][a-z0-9-]{0,80}$ ]] || fail 'Not a container name.'
    mine "$arg" || { [ "$action" = remove ] && { echo '{"ok":true}'; exit 0; }; fail "No container $arg of $app."; }
    case "$action" in
      remove) docker rm -f "$arg" >/dev/null ;;
      stop) docker stop -t 30 "$arg" >/dev/null ;;
      start) docker start "$arg" >/dev/null ;;
    esac || fail "docker $action $arg failed." 3
    echo '{"ok":true}' ;;
  retire)
    [[ "$arg" =~ ^[a-z][a-z0-9-]{0,80}$ ]] || fail 'Not a container name.'
    stopped=()
    for id in $(ids); do
      n=$(docker inspect -f '{{.Name}}' "$id" | sed 's#^/##')
      [ "$n" = "$arg" ] && continue
      docker stop -t 30 "$id" >/dev/null 2>&1; docker rm "$id" >/dev/null 2>&1 && stopped+=("\"$n\"")
    done
    printf '{"ok":true,"stopped":[%s]}\n' "$(IFS=,; echo "${stopped[*]:-}")" ;;
  state)
    out=()
    for id in $(ids); do
      out+=("$(docker inspect -f '{"name":"{{.Name}}","state":"{{.State.Status}}","restarts":{{.RestartCount}},"exitCode":{{.State.ExitCode}}}' "$id" | sed 's#"/#"#')")
    done
    printf '{"ok":true,"containers":[%s]}\n' "$(IFS=,; echo "${out[*]:-}")" ;;
  logs)
    [[ "$arg" =~ ^[a-z][a-z0-9-]{0,80}$ ]] || fail 'Not a container name.'
    [[ "$lines" =~ ^[0-9]{1,4}$ ]] || fail 'Not a line count.'
    mine "$arg" || fail "No container $arg of $app."
    docker logs --tail "$lines" --timestamps "$arg" 2>&1 | tail -c 200000 ;;
  prune)
    [[ "$arg" =~ ^[0-9]{1,2}$ ]] || fail 'Not a count.'
    used=$(docker ps -a --filter "label=noobly-app=$app" --format '{{.Image}}')
    removed=0
    for image in $(docker images "noobly-app/$app" --format '{{.Repository}}:{{.Tag}}' | tail -n +"$((arg + 1))"); do
      grep -qxF "$image" <<<"$used" && continue
      docker rmi "$image" >/dev/null 2>&1 && removed=$((removed + 1))
    done
    printf '{"ok":true,"removed":%s}\n' "$removed" ;;
  delete)
    for id in $(ids); do docker rm -f "$id" >/dev/null 2>&1; done
    for image in $(docker images "noobly-app/$app" -q | sort -u); do docker rmi -f "$image" >/dev/null 2>&1; done
    sudo rm -rf "/srv/apps/$app"
    echo '{"ok":true}' ;;
  *) fail 'Not an action.' ;;
esac
