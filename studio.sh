#!/bin/bash
# VideoRouter server + Tailscale proxy launcher; compatible with macOS Bash 3.2.
set -euo pipefail
umask 077

studio_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
studio_data="$studio_root/data"
studio_pidfile="$studio_data/launcher.pid"
studio_log="$studio_data/studio.log"
studio_proxyfile="$studio_data/tailscale.pid"
# Existing Mac and sole iOS peer; override only when the device addresses change.
studio_mac="${TAILSCALE_MAC_IP:-100.80.72.44}"
studio_phone="${TAILSCALE_PHONE_IP:-100.121.194.63}"
studio_proxy_pid=''
studio_proxy_port=''
studio_proxy_mac=''
studio_proxy_phone='' 
studio_action="${1:-start}"
studio_node="$(command -v node || true)"
if [[ -z "$studio_node" && -x /opt/homebrew/bin/node ]]; then studio_node=/opt/homebrew/bin/node; fi
if [[ -z "$studio_node" && -x /usr/local/bin/node ]]; then studio_node=/usr/local/bin/node; fi
fail() { echo "Ошибка: $*" >&2; exit 1; }
usage() {
  echo "Использование: ./studio.sh [start|restart|stop|status|logs]"
  echo "Без аргументов — запуск сервера и Tailscale-прокси в фоне. PORT=8792 ./studio.sh start — другой порт."
  echo "Лог: $studio_log"
}
case "$studio_action" in start|restart|stop|status|logs) ;; -h|--help|help) usage; exit 0 ;; *) usage; exit 1 ;; esac
[[ $# -le 1 ]] || { usage; exit 1; }
[[ -n "$studio_node" ]] || fail 'Нужен Node.js 26; node не найден в PATH или Homebrew.'
[[ "$("$studio_node" -p 'process.versions.node.split(".")[0]')" -ge 26 ]] || fail 'Нужен Node.js 26 или новее.'
mkdir -p "$studio_data"
if [[ "$studio_action" == logs ]]; then touch "$studio_log"; exec tail -n 60 -f "$studio_log"; fi
studio_lock="$studio_data/launcher.lock"
mkdir "$studio_lock" 2>/dev/null || fail "Другая команда запуска ещё выполняется. Если она аварийно завершилась, удалите пустую папку $studio_lock."
trap 'rmdir "$studio_lock" 2>/dev/null || true' EXIT

studio_pid=''
studio_port=''
load_process() {
  [[ -f "$studio_pidfile" ]] || return 1
  read -r studio_pid studio_port < "$studio_pidfile" || return 1
  [[ "$studio_pid" =~ ^[0-9]+$ && "$studio_port" =~ ^[0-9]+$ ]] || fail 'Повреждён data/launcher.pid.'
  kill -0 "$studio_pid" 2>/dev/null || { rm -f "$studio_pidfile"; return 1; }
  local process_command
  process_command="$(ps -p "$studio_pid" -o command=)"
  [[ "$process_command" == "$studio_node $studio_root/server.mjs" ]] || fail "PID $studio_pid принадлежит другому процессу. Он не будет остановлен. Проверьте data/launcher.pid."
}
ready() {
  curl --noproxy '*' --silent --fail --max-time 2 -H 'X-Studio: 1' "http://127.0.0.1:$studio_port/local/state" > "$studio_lock/state.json"
}
load_proxy() {
  [[ -f "$studio_proxyfile" ]] || return 1
  read -r studio_proxy_pid studio_proxy_port studio_proxy_mac studio_proxy_phone < "$studio_proxyfile" || return 1
  [[ "$studio_proxy_pid" =~ ^[0-9]+$ && "$studio_proxy_port" =~ ^[0-9]+$ ]] || fail 'Повреждён data/tailscale.pid.'
  kill -0 "$studio_proxy_pid" 2>/dev/null || { rm -f "$studio_proxyfile"; return 1; }
  local process_command
  process_command="$(ps -p "$studio_proxy_pid" -o command=)"
  [[ "$process_command" == "$studio_node $studio_root/tailscale.mjs $studio_proxy_mac $studio_proxy_phone" ]] || fail "PID $studio_proxy_pid принадлежит другому процессу. Проверьте data/tailscale.pid."
}
proxy_ready() {
  curl --noproxy '*' --interface "$studio_proxy_mac" --silent --fail --max-time 2 -H 'X-Studio: 1' "http://$studio_proxy_mac:$studio_proxy_port/local/state" > /dev/null
}
validate_addresses() {
  "$studio_node" -e 'const {isIPv4}=require("node:net");for(const ip of process.argv.slice(1)){const n=ip.split(".").map(Number);if(!isIPv4(ip)||n[0]!==100||n[1]<64||n[1]>127)process.exit(1)}' "$studio_mac" "$studio_phone" || fail 'Укажите Tailscale IPv4 Mac и телефона через TAILSCALE_MAC_IP и TAILSCALE_PHONE_IP.'
}
terminate_process() {
  local pid="$1" pidfile="$2" attempt
  kill -TERM "$pid" 2>/dev/null || true
  for attempt in {1..50}; do
    if ! kill -0 "$pid" 2>/dev/null; then rm -f "$pidfile"; return; fi
    sleep 0.1
  done
  fail "Процесс $pid ещё завершается. Принудительное завершение не выполнялось."
}
stop_studio() {
  local server_up=0 proxy_up=0
  if load_process; then server_up=1; fi
  if load_proxy; then proxy_up=1; fi
  if [[ "$server_up" == 1 ]]; then
    ready || fail 'Сервер не отвечает. Остановка обоих процессов отменена: невозможно проверить активные задания.'
    "$studio_node" -e 'const fs=require("node:fs");const s=JSON.parse(fs.readFileSync(process.argv[1]));if(!Array.isArray(s.runs)||s.runs.some(r=>r.status==="running"))process.exit(1)' "$studio_lock/state.json" || fail 'Есть активные задания или неизвестный ответ сервера. Дождитесь завершения перед остановкой.'
  fi
  if [[ "$proxy_up" == 1 ]]; then terminate_process "$studio_proxy_pid" "$studio_proxyfile"; fi
  if [[ "$server_up" == 1 ]]; then terminate_process "$studio_pid" "$studio_pidfile"; fi
  echo 'Сервер и Tailscale-прокси остановлены.'
}
start_proxy() {
  if load_proxy; then
    [[ "$studio_proxy_port" == "$studio_port" && "$studio_proxy_mac" == "$studio_mac" && "$studio_proxy_phone" == "$studio_phone" ]] || fail 'Параметры работающего прокси отличаются. Используйте restart.'
    proxy_ready || fail 'Tailscale-прокси запущен, но не отвечает. Проверьте Tailscale и лог.'
    return
  fi
  cd "$studio_root"
  PORT="$studio_port" nohup "$studio_node" "$studio_root/tailscale.mjs" "$studio_mac" "$studio_phone" >> "$studio_log" 2>&1 < /dev/null &
  studio_proxy_pid=$!
  studio_proxy_port="$studio_port"; studio_proxy_mac="$studio_mac"; studio_proxy_phone="$studio_phone"
  printf '%s %s %s %s\n' "$studio_proxy_pid" "$studio_port" "$studio_mac" "$studio_phone" > "$studio_proxyfile"
  local attempt
  for attempt in {1..30}; do
    if ! kill -0 "$studio_proxy_pid" 2>/dev/null; then rm -f "$studio_proxyfile"; return 1; fi
    if proxy_ready; then return; fi
    sleep 0.1
  done
  terminate_process "$studio_proxy_pid" "$studio_proxyfile"
  return 1
}
show_urls() {
  echo "На Mac: http://127.0.0.1:$studio_port (PID $studio_pid)"
  echo "На телефоне через Tailscale: http://$studio_proxy_mac:$studio_proxy_port (PID $studio_proxy_pid)"
  echo "Лог обоих процессов: $studio_log"
}
start_studio() {
  validate_addresses
  if load_process; then
    ready || fail 'Сервер запущен, но не отвечает. Проверьте лог.'
    start_proxy || fail "Сервер работает, но Tailscale-прокси не запущен. Проверьте Tailscale и $studio_log"
    show_urls
    return
  fi
  studio_port="${PORT:-8791}"
  [[ "$studio_port" =~ ^[1-9][0-9]{0,4}$ && "$studio_port" -le 65535 ]] || fail 'PORT должен быть числом от 1 до 65535.'
  if /usr/sbin/lsof -nP -iTCP@127.0.0.1:"$studio_port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "Порт $studio_port занят. Если сервер запущен вручную, остановите его в исходном терминале."
  fi
  cd "$studio_root"
  PORT="$studio_port" nohup "$studio_node" "$studio_root/server.mjs" >> "$studio_log" 2>&1 < /dev/null &
  studio_pid=$!
  printf '%s %s\n' "$studio_pid" "$studio_port" > "$studio_pidfile"
  local attempt
  for attempt in {1..50}; do
    if ! kill -0 "$studio_pid" 2>/dev/null; then
      rm -f "$studio_pidfile"; fail "Не удалось запустить студию. Подробности: $studio_log"
    fi
    if ready; then
      if start_proxy; then show_urls; return; fi
      terminate_process "$studio_pid" "$studio_pidfile"
      fail "Tailscale-прокси не запустился; новый сервер также остановлен. Проверьте подключение Tailscale, адреса и $studio_log"
    fi
    sleep 0.1
  done
  fail "Процесс запущен, но готовность пока не подтверждена. Проверьте ./studio.sh status и $studio_log"
}
# state.json exists only while the command holds the lock.
trap 'rm -f "$studio_lock/state.json"; rmdir "$studio_lock" 2>/dev/null || true' EXIT
case "$studio_action" in
  start) start_studio ;;
  restart)
    validate_addresses
    if load_proxy; then
      studio_mac="${TAILSCALE_MAC_IP:-$studio_proxy_mac}"
      studio_phone="${TAILSCALE_PHONE_IP:-$studio_proxy_phone}"
      PORT="${PORT:-$studio_proxy_port}"
    fi
    if load_process; then PORT="${PORT:-$studio_port}"; fi
    stop_studio
    start_studio
    echo 'Ключи, введённые в интерфейсе, нужно подключить заново. Ключи из окружения используются при запуске.'
    ;;
  stop) stop_studio ;;
  status)
    server_up=0; proxy_up=0
    if load_process; then server_up=1; fi
    if load_proxy; then proxy_up=1; fi
    if [[ "$server_up" == 0 && "$proxy_up" == 0 ]]; then
      echo 'Сервер и Tailscale-прокси не запущены этим скриптом.'
    elif [[ "$server_up" == 1 && "$proxy_up" == 1 ]] && ready && proxy_ready; then
      show_urls
    else
      fail "Студия работает не полностью: server=$server_up, tailscale=$proxy_up. Проверьте лог; start восстановит отсутствующий прокси."
    fi
    ;;
esac
