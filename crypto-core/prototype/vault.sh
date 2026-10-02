#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
P="$ROOT/people"; R="$ROOT/recipients"; S="$ROOT/spaces"; STORE="$ROOT/server-storage"
mkdir -p "$P" "$R" "$S" "$STORE"

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  init-user)
    name="$1"
    age-keygen -o "$P/$name.key" >/dev/null 2>&1
    chmod 600 "$P/$name.key"
    age-keygen -y "$P/$name.key" > "$R/$name.pub" 2>/dev/null
    echo "создан пользователь: $name (приватный ключ на «флешке» people/$name.key)"
    ;;
  init-space)
    space="$1"; shift
    : > "$S/$space.members"
    for u in "$@"; do cat "$R/$u.pub" >> "$S/$space.members"; done
    echo "создано пространство: $space  (участники: $*)"
    ;;
  submit)
    space="$1"; file="$2"
    base="$(basename "$file")"
    age -R "$S/$space.members" -o "$STORE/$space--$base.age" "$file"
    echo "зашифровано и отправлено на «сервер»: $space--$base.age"
    ;;
  read)
    user="$1"; blob="$2"
    age -d -i "$P/$user.key" "$STORE/$blob"
    ;;
  list-server)
    ls -1 "$STORE"
    ;;
  *)
    echo "команды: init-user <имя> | init-space <простр> <участники...> | submit <простр> <файл> | read <польз> <blob> | list-server"
    ;;
esac
