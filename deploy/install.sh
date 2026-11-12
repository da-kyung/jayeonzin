#!/usr/bin/env bash
# =============================================================================
#  동탄국제고 학부모 소통방 - 서버 설치 스크립트 (Ubuntu 22.04 / 24.04)
#
#  사용법 (서버에 root로 접속한 뒤 한 줄 실행):
#    curl -fsSL https://raw.githubusercontent.com/da-kyung/jayeonzin/claude/school-parent-communication-app-8ao6z5/deploy/install.sh | bash
#
#  하는 일:
#    1) Node.js 22, Caddy(HTTPS 자동 발급 웹서버), sqlite3 설치
#    2) 앱 내려받기 → /opt/board,  데이터 → /var/lib/board
#    3) 입장 코드 · 운영자 비밀번호 설정 → /etc/board.env
#    4) 서버 재부팅 시 자동 실행(systemd), 매일 자동 백업(14일 보관), 보안 업데이트 자동 적용
#
#  다시 실행해도 안전합니다. 기존 설정·데이터는 유지됩니다.
#  도메인 변경:  DOMAIN=talk.example.kr bash /opt/board/deploy/install.sh
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/da-kyung/jayeonzin.git}"
BRANCH="${BRANCH:-claude/school-parent-communication-app-8ao6z5}"
APP_DIR=/opt/board
DATA_DIR=/var/lib/board
ENV_FILE=/etc/board.env
BACKUP_DIR=/var/backups/board
APP_PORT=3000

say()  { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✕ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root 권한으로 실행해주세요. (sudo -i 후 다시 실행)"
grep -qi ubuntu /etc/os-release || die "Ubuntu 서버에서만 지원합니다."
export DEBIAN_FRONTEND=noninteractive

# 파이프(curl | bash)로 실행해도 질문에 답할 수 있도록 터미널에서 직접 읽기
ask() { # ask 변수명 "질문" [기본값] [secret]
  local __var=$1 __q=$2 __def=${3:-} __secret=${4:-} __ans=""
  while :; do
    if [ -n "$__secret" ]; then read -r -s -p "$__q: " __ans </dev/tty; echo >/dev/tty
    else read -r -p "$__q${__def:+ [$__def]}: " __ans </dev/tty; fi
    __ans=${__ans:-$__def}
    [ -n "$__ans" ] && break
    echo "  값을 입력해주세요." >/dev/tty
  done
  printf -v "$__var" '%s' "$__ans"
}

# ---------------------------------------------------------------------------
say "1/7 기본 패키지 설치"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg sqlite3 unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
say "2/7 Node.js 22 설치"
need_node=1
if command -v node >/dev/null; then
  v=$(node -p 'process.versions.node.split(".").map(Number).reduce((a,x,i)=>a+x*[1e6,1e3,1][i],0)')
  # 사용자 폴더(nvm 등)에 설치된 Node는 서비스 계정이 쓸 수 없으므로 새로 설치
  case "$(readlink -f "$(command -v node)")" in /root/*|/home/*) v=0 ;; esac
  [ "$v" -ge 22013000 ] && need_node=0
fi
if [ $need_node -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN=$(command -v node)
case "$NODE_BIN" in /usr/bin/node|/usr/local/bin/node) ;; *) [ -x /usr/bin/node ] && NODE_BIN=/usr/bin/node ;; esac
echo "  $($NODE_BIN -v)  ($NODE_BIN)"

# ---------------------------------------------------------------------------
say "3/7 Caddy(HTTPS 웹서버) 설치"
if ! command -v caddy >/dev/null; then
  # Caddy 공식 저장소 → 실패하면 Ubuntu 기본 저장소에서 설치
  if key=$(curl -1sLf --max-time 20 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key') && [ -n "$key" ] \
     && echo "$key" | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
     && curl -1sLf --max-time 20 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list; then
    apt-get update -y
  else
    warn "Caddy 공식 저장소에 연결하지 못해 Ubuntu 기본 저장소에서 설치합니다."
    rm -f /etc/apt/sources.list.d/caddy-stable.list
  fi
  apt-get install -y caddy || die "Caddy 설치 실패. 인터넷 연결을 확인해주세요."
fi

# ---------------------------------------------------------------------------
say "4/7 앱 내려받기"
id board >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin board
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  rm -rf "$APP_DIR"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown -R board:board "$DATA_DIR"
chmod 700 "$DATA_DIR" "$BACKUP_DIR"

# ---------------------------------------------------------------------------
say "5/7 접속 주소 · 비밀번호 설정"
PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)}"
[ -n "$PUBLIC_IP" ] || ask PUBLIC_IP "서버 공인 IP를 입력하세요"

# 기존 설정 불러오기
OLD_DOMAIN=""
if [ -f "$ENV_FILE" ]; then
  OLD_DOMAIN=$(grep -E '^SITE_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)
fi
if [ -z "${DOMAIN:-}" ]; then
  DOMAIN="${OLD_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
fi
echo "  접속 주소: https://$DOMAIN"

if [ ! -f "$ENV_FILE" ]; then
  ACCESS_CODE="${ACCESS_CODE:-}"; ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
  if [ -z "$ACCESS_CODE" ]; then
    echo
    echo "  학부모님들이 처음 들어올 때 입력할 '입장 코드'를 정해주세요. (가정통신문으로 안내할 코드)"
    ask ACCESS_CODE "  입장 코드 (4자리 이상)"
  fi
  while [ ${#ACCESS_CODE} -lt 4 ]; do ask ACCESS_CODE "  4자리 이상으로 입력해주세요"; done
  [ -z "$ADMIN_PASSWORD" ] && echo "  운영자(선생님/학부모회) 비밀번호를 정해주세요. 화면에 표시되지 않습니다."
  while [ ${#ADMIN_PASSWORD} -lt 8 ]; do
    ask ADMIN_PASSWORD "  운영자 비밀번호 (8자 이상)" "" secret
    [ ${#ADMIN_PASSWORD} -ge 8 ] || { echo "  8자 이상으로 정해주세요."; ADMIN_PASSWORD=""; continue; }
    ask ADMIN_PASSWORD2 "  한 번 더 입력" "" secret
    [ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD2" ] && break
    echo "  두 비밀번호가 다릅니다. 다시 입력해주세요."; ADMIN_PASSWORD=""
  done
  umask 077
  cat > "$ENV_FILE" <<EOF
# 학부모 소통방 설정 (수정 후: systemctl restart board)
SCHOOL_NAME=동탄국제고 학부모 소통방
ACCESS_CODE=$ACCESS_CODE
ADMIN_PASSWORD=$ADMIN_PASSWORD
THEME_COLOR=#d7263a
PUBLIC_FIRST_RATIO=0.7
DATA_DIR=$DATA_DIR
PORT=$APP_PORT
HOST=127.0.0.1
SECURE_COOKIE=1
SITE_DOMAIN=$DOMAIN
EOF
  umask 022
else
  echo "  기존 설정($ENV_FILE)을 그대로 사용합니다."
  if grep -q '^SITE_DOMAIN=' "$ENV_FILE"; then sed -i "s|^SITE_DOMAIN=.*|SITE_DOMAIN=$DOMAIN|" "$ENV_FILE"
  else echo "SITE_DOMAIN=$DOMAIN" >> "$ENV_FILE"; fi
fi
chown root:board "$ENV_FILE"; chmod 640 "$ENV_FILE"

# ---------------------------------------------------------------------------
say "6/7 자동 실행 · HTTPS 설정"
cat > /etc/systemd/system/board.service <<EOF
[Unit]
Description=학부모 소통방
After=network-online.target
Wants=network-online.target

[Service]
User=board
Group=board
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --no-warnings $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
# 학부모 소통방 - HTTPS 인증서는 Caddy가 자동 발급·갱신합니다.
$DOMAIN {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:$APP_PORT
}
EOF

systemctl daemon-reload
systemctl enable --now board
systemctl restart board
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ---------------------------------------------------------------------------
say "7/7 매일 자동 백업 설정"
cat > /etc/cron.daily/board-backup <<EOF
#!/bin/sh
# 매일 DB를 안전하게 복사하고 14일 지난 백업은 삭제
set -e
[ -s $DATA_DIR/board.db ] || exit 0   # 아직 DB가 없으면 건너뜀
d=\$(date +%F)
sqlite3 $DATA_DIR/board.db ".backup '$BACKUP_DIR/board-\$d.db'"
cp $DATA_DIR/secret.key $BACKUP_DIR/secret.key 2>/dev/null || true
find $BACKUP_DIR -name 'board-*.db' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/board-backup

# ---------------------------------------------------------------------------
sleep 2
if curl -fsS --max-time 5 "http://127.0.0.1:$APP_PORT/api/me" >/dev/null; then
  APP_OK="정상 실행 중"
else
  APP_OK="실행 확인 실패 → journalctl -u board -n 50 으로 로그를 확인하세요"
fi

cat <<EOF

=====================================================================
 ✅ 설치 완료  (앱: $APP_OK)

 접속 주소 :  https://$DOMAIN
   - 처음 접속 시 HTTPS 인증서 발급에 1~2분 걸릴 수 있습니다.
   - 열리지 않으면 네이버클라우드 ACG에서 80, 443 포트가 열려 있는지 확인하세요.

 다음 할 일
   1) 위 주소 접속 → 더보기 → 운영자 로그인
   2) 학교 홈페이지 연동에 공지사항/가정통신문 게시판 주소 등록
   3) 휴대폰에서 '홈 화면에 추가' 확인 후 학부모 안내

 자주 쓰는 명령
   설정 수정  : nano $ENV_FILE  →  systemctl restart board
   업데이트   : bash $APP_DIR/deploy/update.sh
   로그 보기  : journalctl -u board -n 50
   백업 위치  : $BACKUP_DIR (매일, 14일 보관)
   도메인 변경: DOMAIN=새도메인 bash $APP_DIR/deploy/install.sh
=====================================================================
EOF
