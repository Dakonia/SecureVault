#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
V="$ROOT/vault.sh"
rm -rf "$ROOT/people" "$ROOT/recipients" "$ROOT/spaces" "$ROOT/server-storage" "$ROOT"/report*.txt

echo "=== 1. Создаём людей (у каждого своя «флешка» с ключом) ==="
bash "$V" init-user boss
bash "$V" init-user director7
bash "$V" init-user director3

echo; echo "=== 2. Пространства: ресторан = директор + boss (полный доступ) ==="
bash "$V" init-space resto-7 director7 boss
bash "$V" init-space resto-3 director3 boss

echo; echo "=== 3. Директор №7 сдаёт отчёт ==="
printf 'Ресторан №7\nВыручка: 812000\nФудкост: 31%%\nФОТ: 24%%\n' > "$ROOT/report7.txt"
bash "$V" submit resto-7 "$ROOT/report7.txt"
BLOB="resto-7--report7.txt.age"

echo; echo "--- Директор №7 открывает свой отчёт, вот что он видит: ---"
bash "$V" read director7 "$BLOB"

check() {
  desc="$1"; expect="$2"; shift 2
  if "$@" >/dev/null 2>&1; then res=ok; else res=fail; fi
  if [ "$res" = "$expect" ]; then echo "  ✅ $desc"; else echo "  ❌ $desc  (ждали $expect, вышло $res)"; fi
}

echo; echo "=== 4. Приёмочные проверки ==="
check "Директор №7 открывает свой отчёт" ok bash "$V" read director7 "$BLOB"
check "Boss (полный доступ) открывает отчёт" ok bash "$V" read boss "$BLOB"
check "Директор №3 НЕ открывает чужой отчёт" fail bash "$V" read director3 "$BLOB"

echo; echo "=== 5. Что видит сервер (папка server-storage) ==="
if grep -q "Выручка" "$ROOT/server-storage/$BLOB" 2>/dev/null; then
  echo "  ❌ на сервере видно слово 'Выручка'"
else
  echo "  ✅ на сервере слова 'Выручка' НЕТ — только нечитаемый шифротекст"
fi
echo "  первые байты файла на сервере:"
head -c 80 "$ROOT/server-storage/$BLOB" | tr -c '[:print:]' '.' ; echo
