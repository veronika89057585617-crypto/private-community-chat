#!/bin/bash
cd "$(dirname "$0")"
clear

echo "=============================================="
echo " PRIVATE COMMUNITY — запуск сайта на MacBook"
echo "=============================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не установлен."
  echo "Сейчас откроется сайт Node.js."
  echo "Скачайте LTS-версию, установите её и потом снова запустите эту команду."
  open "https://nodejs.org/"
  echo ""
  read -p "После установки Node.js нажмите Enter, чтобы закрыть это окно..."
  exit 1
fi

ADMIN_SECRET=$(node -e "const fs=require('fs');const db=JSON.parse(fs.readFileSync('./data/db.json','utf8'));process.stdout.write(db.adminSecret)")

PORT_TO_USE=$(node - <<'NODE'
const net = require('net');
function check(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
(async () => {
  if (await check(8088)) return console.log(8088);
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => console.log(p));
  });
})();
NODE
)

ADMIN_URL="http://localhost:${PORT_TO_USE}/admin/${ADMIN_SECRET}"

echo "Сайт запускается..."
echo ""
echo "Администраторская ссылка:"
echo "$ADMIN_URL"
echo ""
echo "Браузер откроется сам. PIN-кода нет."
echo "Если браузер не открылся — скопируйте ссылку выше и вставьте в Safari или Chrome."
echo ""
echo "ВАЖНО: не закрывайте это окно, пока пользуетесь сайтом."
echo ""

(sleep 3; open "$ADMIN_URL") &
PORT=$PORT_TO_USE node server.js
