#!/usr/bin/env bash
set -u
DIR="$(cd "$(dirname "$0")" && pwd)/pw-demo"
rm -rf "$DIR"; mkdir -p "$DIR"; cd "$DIR"
PW="verno123"
WRONG="podbor000"

wrap() {
  expect -c "
    spawn age -p -o \"$2\" \"$1\"
    expect -re \"assphrase\"; send \"$3\r\"
    expect -re \"assphrase\"; send \"$3\r\"
    expect eof
  " >/dev/null 2>&1
}

unlock() {
  rm -f "$2"
  expect -c "
    spawn age -d -o \"$2\" \"$1\"
    expect -re \"assphrase\"; send \"$3\r\"
    expect eof
  " >/dev/null 2>&1
  grep -q "AGE-SECRET-KEY" "$2" 2>/dev/null
}

echo "=== Настройка: у директора №7 вход по ПАРОЛЮ ==="
age-keygen -o id_plain.txt >/dev/null 2>&1
age-keygen -y id_plain.txt > id.pub 2>/dev/null
wrap id_plain.txt flash.key "$PW"
rm -f id_plain.txt
echo "На диске лежит только ключ, ЗАПЕРТЫЙ паролем: flash.key"
echo "Открытого секрета на диске больше нет."

echo; echo "=== Директору сдают отчёт (шифруют на его публичный ключ) ==="
printf 'Ресторан №7\nВыручка: 812000\n' > report.txt
age -R id.pub -o report.age report.txt
rm -f report.txt
echo "Зашифровано: report.age"

echo; echo "=== Проверки ==="
if unlock flash.key id_ok.txt "$PW" && age -d -i id_ok.txt report.age >/dev/null 2>&1; then
  echo "  ✅ ПРАВИЛЬНЫЙ пароль — ключ открылся, отчёт читается"
else
  echo "  ❌ сбой при правильном пароле"
fi
rm -f id_ok.txt

if unlock flash.key id_bad.txt "$WRONG"; then
  echo "  ❌ НЕВЕРНЫЙ пароль почему-то сработал"
else
  echo "  ✅ НЕВЕРНЫЙ пароль — ключ НЕ открылся, отчёт недоступен"
fi
rm -f id_bad.txt

echo; echo "=== Что видно при ВЕРНОМ пароле: ==="
unlock flash.key id_show.txt "$PW" && age -d -i id_show.txt report.age
rm -f id_show.txt
