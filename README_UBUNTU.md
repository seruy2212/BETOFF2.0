# BETOFF — односерверная установка (Ubuntu 22.04, Oracle Free Tier)

## Что получится
- Сайт и API на одном сервере по IP и **порту 3001**:
  - Главная: `http://<PUBLIC_IP>:3001/`
  - Админка: `http://<PUBLIC_IP>:3001/admin` (пароль по умолчанию: `betoff07` — см. server/.env)
- Хранение ставок в `server/data/bets.json` + авто-бэкапы в `server/backups/`
- Реалтайм-обновления через Socket.IO

## 0) Открыть порт 3001 в Oracle
В Security List/NSG добавьте Ingress правило TCP **3001** от `0.0.0.0/0`.

## 1) Установить зависимости на сервере
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git unzip curl build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
node -v && npm -v
```

## 2) Залить архив и распаковать
Через Bitvise SFTP закиньте ZIP в `/home/ubuntu/`, затем:
```bash
cd ~
unzip betoff-ubuntu-single-3.9.2.zip -d betoff
```

## 3) Собрать фронт и установить сервер
```bash
cd ~/betoff/client && npm install && npm run build
cd ../server && npm install
printf "ADMIN_PASSWORD=betoff07\nPORT=3001\n" > .env
mkdir -p data backups
[ -f data/bets.json ] || echo "[]" > data/bets.json
```

## 4) Тестовый запуск (по желанию)
```bash
node server.js
# В другой вкладке:
curl -sI http://127.0.0.1:3001/api/health   # должно быть 200 OK
```

## 5) Автозапуск как сервис
```bash
sudo cp ~/betoff/ops/betoff.service /etc/systemd/system/betoff.service
sudo systemctl daemon-reload
sudo systemctl enable betoff
sudo systemctl start betoff
sudo systemctl status betoff --no-pager
```

## 6) Открыть сайт
С любого устройства: `http://<PUBLIC_IP>:3001/`  
Админка: `http://<PUBLIC_IP>:3001/admin`

## Диагностика
```bash
journalctl -u betoff -n 200 -f
curl -sI http://127.0.0.1:3001/api/health
sudo ss -ltnp | egrep ':3001 '
```