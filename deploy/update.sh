#!/usr/bin/env bash
# 최신 버전으로 업데이트 (데이터·설정은 그대로 유지)
#   사용법: bash /opt/board/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/board
BRANCH="${BRANCH:-$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo claude/school-parent-communication-app-8ao6z5)}"
[ "$(id -u)" -eq 0 ] || { echo "root 권한으로 실행해주세요."; exit 1; }
[ "$BRANCH" = "HEAD" ] && BRANCH=claude/school-parent-communication-app-8ao6z5

echo "▶ 업데이트 전 백업"
/etc/cron.daily/board-backup || true

echo "▶ 최신 코드 받기 ($BRANCH)"
before=$(git -C "$APP_DIR" rev-parse --short HEAD)
git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
git -C "$APP_DIR" reset --hard FETCH_HEAD
after=$(git -C "$APP_DIR" rev-parse --short HEAD)

echo "▶ 재시작"
systemctl restart board
sleep 2
if curl -fsS --max-time 5 http://127.0.0.1:3000/api/me >/dev/null; then
  echo "✅ 업데이트 완료 ($before → $after)"
else
  echo "✕ 실행 확인 실패. 이전 버전으로 되돌립니다."
  git -C "$APP_DIR" fetch --depth 50 origin "$BRANCH" >/dev/null 2>&1 || true
  git -C "$APP_DIR" reset --hard "$before" && systemctl restart board
  echo "  되돌림 완료. 로그: journalctl -u board -n 50"
  exit 1
fi
