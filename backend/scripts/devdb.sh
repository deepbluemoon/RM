#!/bin/sh
# 로컬 개발·테스트용 MariaDB 12.0 인스턴스 (팀 DB 와 별개). 데이터는 backend/var/devdb (git 제외)
set -e
cd "$(dirname "$0")/.."
DIR="$PWD/var/devdb"
BIN=/opt/homebrew/opt/mariadb/bin
PORT="${DEVDB_PORT:-23610}"
case "$1" in
  start)
    if [ ! -d "$DIR/data/mysql" ]; then
      mkdir -p "$DIR"
      "$BIN/mariadb-install-db" --datadir="$DIR/data" --auth-root-authentication-method=normal --skip-test-db >/dev/null
    fi
    if [ -f "$DIR/mysqld.pid" ] && kill -0 "$(cat "$DIR/mysqld.pid")" 2>/dev/null; then echo "devdb already running on $PORT"; exit 0; fi
    nohup "$BIN/mariadbd" --no-defaults --datadir="$DIR/data" --socket="$DIR/mysqld.sock" --port="$PORT" \
      --bind-address=127.0.0.1 --pid-file="$DIR/mysqld.pid" --log-error="$DIR/error.log" \
      --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --default-time-zone=+09:00 >/dev/null 2>&1 &
    sleep 3; echo "devdb started on 127.0.0.1:$PORT (socket $DIR/mysqld.sock)";;
  stop)
    [ -f "$DIR/mysqld.pid" ] && kill "$(cat "$DIR/mysqld.pid")" && echo "devdb stopped" || echo "devdb not running";;
  *) echo "usage: devdb.sh start|stop"; exit 1;;
esac
