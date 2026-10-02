#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
P="$ROOT/people"; R="$ROOT/recipients"; S="$ROOT/spaces"
mkdir -p "$P" "$R" "$S"
: "${SERVER_URL:?set SERVER_URL}"

curl_do() {
  local opts=(-s)
  [ -n "${CA_CERT:-}" ] && opts+=(--cacert "$CA_CERT")
  [ -n "${CLIENT_CERT:-}" ] && opts+=(--cert "$CLIENT_CERT" --key "$CLIENT_KEY")
  [ -n "${SV_TOKEN:-}" ] && opts+=(-H "Authorization: Bearer $SV_TOKEN")
  curl "${opts[@]}" "$@"
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  init-user)
    n="$1"
    age-keygen -o "$P/$n.key" >/dev/null 2>&1; chmod 600 "$P/$n.key"
    age-keygen -y "$P/$n.key" > "$R/$n.pub" 2>/dev/null
    echo "пользователь: $n" ;;
  init-space)
    sp="$1"; shift
    : > "$S/$sp.members"
    for u in "$@"; do cat "$R/$u.pub" >> "$S/$sp.members"; done
    echo "пространство: $sp (участники: $*)" ;;
  submit)
    sp="$1"; ty="$2"; by="$3"; f="$4"
    tmp="$(mktemp)"
    age -R "$S/$sp.members" -o "$tmp" "$f"
    curl_do -X POST -F "space=$sp" -F "type=$ty" -F "by=$by" -F "name=$(basename "$f")" -F "file=@$tmp" \
      "$SERVER_URL/records" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p'
    rm -f "$tmp" ;;
  list)
    curl_do "$SERVER_URL/records?space=$1" ;;
  read)
    u="$1"; id="$2"
    tmp="$(mktemp)"
    curl_do "$SERVER_URL/blobs/$id" -o "$tmp"
    age -d -i "$P/$u.key" "$tmp"; rc=$?
    rm -f "$tmp"; exit $rc ;;
  *)
    echo "команды: init-user | init-space | submit <простр> <тип> <кто> <файл> | list <простр> | read <польз> <id>" ;;
esac
