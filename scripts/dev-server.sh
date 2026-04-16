#!/bin/bash
# デバッグサーバー管理スクリプト
# 使用法: ./scripts/dev-server.sh {start|stop|status}
# 環境変数: WEBAPP_PORT (default: 3012), CHAT_PORT (default: 8082)

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/.dev-logs"
mkdir -p "$LOG_DIR"

WEBAPP_PORT="${WEBAPP_PORT:-3012}"
CHAT_PORT="${CHAT_PORT:-8082}"

start_all() {
    # webapp
    if lsof -ti :$WEBAPP_PORT -sTCP:LISTEN >/dev/null 2>&1; then
        echo "webapp already running (port: $WEBAPP_PORT)"
    else
        cd "$PROJECT_ROOT/apps/webapp"
        PORT=$WEBAPP_PORT nohup pnpm run dev > "$LOG_DIR/webapp.log" 2>&1 &
        echo "webapp started (port: $WEBAPP_PORT)"
    fi

    # chat-agent（.env.localをset -aで環境変数に展開してから起動）
    if lsof -ti :$CHAT_PORT -sTCP:LISTEN >/dev/null 2>&1; then
        echo "chat already running (port: $CHAT_PORT)"
    else
        cd "$PROJECT_ROOT/apps/chat-agent"
        PORT=$CHAT_PORT nohup bash -c 'set -a; source .env.local; set +a; pnpm run dev' > "$LOG_DIR/chat.log" 2>&1 &
        echo "chat started (port: $CHAT_PORT)"
    fi

    echo ""
    echo "Logs:"
    echo "  webapp: $LOG_DIR/webapp.log"
    echo "  chat:   $LOG_DIR/chat.log"
}

stop_all() {
    local name port pid
    for name_port in "webapp:$WEBAPP_PORT" "chat:$CHAT_PORT"; do
        name="${name_port%%:*}"
        port="${name_port##*:}"
        pid=$(lsof -ti :$port -sTCP:LISTEN 2>/dev/null)
        if [ -n "$pid" ]; then
            kill $pid 2>/dev/null && echo "$name stopped (PID: $pid)"
        else
            echo "$name not running"
        fi
    done
}

status_all() {
    local name port pid
    for name_port in "webapp:$WEBAPP_PORT" "chat:$CHAT_PORT"; do
        name="${name_port%%:*}"
        port="${name_port##*:}"
        pid=$(lsof -ti :$port -sTCP:LISTEN 2>/dev/null)
        if [ -n "$pid" ]; then
            echo "$name: running (PID: $pid, port: $port)"
        else
            echo "$name: stopped"
        fi
    done
}

case "$1" in
    start)  start_all ;;
    stop)   stop_all ;;
    status) status_all ;;
    *)
        echo "Usage: $0 {start|stop|status}"
        echo "Environment: WEBAPP_PORT=$WEBAPP_PORT, CHAT_PORT=$CHAT_PORT"
        exit 1
        ;;
esac
