#!/usr/bin/env bash
# 一条命令安装或升级（Debian / Ubuntu / CentOS / Rocky / Alma 等带 systemd 的 Linux，需要 root）：
#   curl -fsSL https://raw.githubusercontent.com/zhong1424535530-pixel/fortuna/main/install.sh | sudo bash
# 可选环境变量：DOMAIN=asset.example.com（已解析到本机，自动申请正式证书，用 80/443 端口）
#              SERVER_ADDRESS=1.2.3.4（没有域名时用 IP 访问，默认自动检测公网 IP，用 8443 端口）
#              REPO=owner/name  REF=main（要安装的仓库和分支或标签）
#              SRC_TARBALL=/root/app.tar.gz（用本地压缩包安装，不从 GitHub 下载）
# 重复运行就是升级：代码重新构建，资料目录、登录绑定和密钥口令保持不变。
set -euo pipefail

REPO=${REPO:-zhong1424535530-pixel/fortuna}
REF=${REF:-main}
APP=/opt/investment-dashboard
DATA=/var/lib/investment-dashboard
CONF=/etc/investment-dashboard
ENVFILE=/etc/investment-dashboard.env

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m安装失败：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "需要 root 权限，请在命令前加 sudo。"
[ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null || die "只支持带 systemd 的 Linux。"
for tool in curl tar; do command -v "$tool" >/dev/null || die "缺少 $tool，请先安装（apt install $tool 或 dnf install $tool）。"; done
case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; *) die "不支持的 CPU 架构：$(uname -m)" ;; esac
mem_mb=$(awk '/MemTotal|SwapTotal/ { total += $2 } END { print int(total / 1024) }' /proc/meminfo)
[ "$mem_mb" -ge 1800 ] || printf '\033[33m提示：内存加虚拟内存只有 %s MB，构建时可能因内存不足被系统终止。建议先开 1 GB swap 再重试。\033[0m\n' "$mem_mb"

node_ok() { command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; }

say "1/6 检查 Node.js（需要 22.13 以上）"
if ! node_ok; then
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && "$(command -v dnf || command -v yum)" install -y nodejs
  else die "无法自动安装 Node.js，请手动安装 22.13 以上版本后重新运行。"; fi
  node_ok || die "Node.js 安装后版本仍不满足要求。"
fi
NODE=$(command -v node)

say "2/6 下载并构建 $REPO@$REF"
id investment >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin investment
id investment-proxy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/investment-proxy --no-create-home --shell /usr/sbin/nologin investment-proxy
install -d -o investment -g investment -m 700 "$DATA"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
chown investment:investment "$work"
mkdir "$work/src"
if [ -n "${SRC_TARBALL:-}" ]; then tar -xzf "$SRC_TARBALL" -C "$work/src"  # 私有仓库或离线时：用 git archive 打好的压缩包安装
else curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$work/src" --strip-components=1; fi
chown -R investment:investment "$work/src"
as_app() { runuser -u investment -- env HOME="$work" npm_config_cache="$work/npm" INVESTMENT_DATA_DIR="$DATA" "$@"; }
(cd "$work/src" && as_app npm ci --no-audit --no-fund && as_app npm run build)

say "3/6 写入配置"
if [ ! -f "$ENVFILE" ]; then
  key=$("$NODE" -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')
  (umask 077; printf 'INVESTMENT_DATA_DIR=%s\nINVESTMENT_MASTER_KEY=%s\n' "$DATA" "$key" > "$ENVFILE")
fi
sed "s#/usr/bin/node#$NODE#" "$work/src/deploy/investment-dashboard.service" > /etc/systemd/system/investment-dashboard.service

say "4/6 切换到新版本"
systemctl stop investment-dashboard 2>/dev/null || true
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$work/src" "$APP"
rm -rf "$APP.old"

say "5/6 配置 HTTPS 入口（Caddy）"
CADDY=$(command -v caddy || true)
if [ -z "$CADDY" ]; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$ARCH" -o /usr/local/bin/caddy && chmod 755 /usr/local/bin/caddy
  CADDY=/usr/local/bin/caddy
fi
install -d -m 755 "$CONF"
# 压缩传输（页面脚本 1.3 MB → 约 0.4 MB），带哈希的静态文件让浏览器长期缓存，再次打开几乎不用下载。
SITE_BODY=$'\tencode zstd gzip\n\t@hashed path /assets/*\n\theader @hashed Cache-Control "public, max-age=31536000, immutable"\n\treverse_proxy 127.0.0.1:4173\n'
if [ -n "${DOMAIN:-}" ]; then
  ADDRESS=$DOMAIN; URL="https://$DOMAIN"; PORTS="80 443"
  printf '%s {\n%s}\n' "$DOMAIN" "$SITE_BODY" > "$CONF/Caddyfile"
else
  # 公网 IP 只在这里用于生成访问地址和证书，探测失败时请用 SERVER_ADDRESS 指定。
  ADDRESS=${SERVER_ADDRESS:-$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}
  [ -n "$ADDRESS" ] || die "无法确定服务器地址，请加上 SERVER_ADDRESS=你的IP 重新运行。"
  URL="https://$ADDRESS:8443"; PORTS="8443"
  printf '{\n\tauto_https disable_redirects\n}\nhttps://%s:8443 {\n\ttls internal\n%s}\n' "$ADDRESS" "$SITE_BODY" > "$CONF/Caddyfile"
fi
cat > /etc/systemd/system/investment-proxy.service <<EOF
[Unit]
Description=Investment dashboard HTTPS proxy
After=network-online.target
Wants=network-online.target

[Service]
User=investment-proxy
StateDirectory=investment-proxy
Environment=XDG_DATA_HOME=/var/lib/investment-proxy XDG_CONFIG_HOME=/var/lib/investment-proxy
ExecStart=$CADDY run --config $CONF/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then for port in $PORTS; do ufw allow "$port/tcp" >/dev/null; done; fi

# 重新绑定或手机丢了以后，直接运行 sudo investment-bind。
cat > /usr/local/bin/investment-bind <<EOF
#!/usr/bin/env bash
exec runuser -u investment -- env INVESTMENT_DATA_DIR=$DATA $NODE --experimental-strip-types $APP/scripts/auth-setup.mjs
EOF
chmod 755 /usr/local/bin/investment-bind
# 动态码连错 5 次会锁定该网络地址 24 小时，运行 sudo investment-unlock 可提前解除。
cat > /usr/local/bin/investment-unlock <<EOF
#!/usr/bin/env bash
exec runuser -u investment -- env INVESTMENT_DATA_DIR=$DATA $NODE --experimental-strip-types $APP/scripts/auth-unlock.mjs
EOF
chmod 755 /usr/local/bin/investment-unlock

say "6/6 启动服务"
systemctl daemon-reload
systemctl enable --now investment-dashboard investment-proxy
systemctl restart investment-proxy
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:4173/api/auth/status >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:4173/api/auth/status >/dev/null 2>&1 || die "服务没有正常启动，请查看：journalctl -u investment-dashboard -n 50"

if [ ! -f "$DATA/auth.json" ]; then
  say "绑定谷歌验证器：用手机扫下面的二维码，再输入验证器上的 6 位数字"
  # 通过 curl | bash 运行时标准输入是管道，所以从终端设备读取输入。
  if (: </dev/tty) 2>/dev/null; then
    /usr/local/bin/investment-bind </dev/tty || printf '\n\033[33m绑定未完成，稍后运行 sudo investment-bind 重试。登录在绑定前不可用。\033[0m\n'
  else
    printf '当前不是交互终端，无法显示二维码。请登录服务器后运行：sudo investment-bind\n'
  fi
fi

printf '\n\033[1m安装完成。\033[0m\n访问地址：%s\n' "$URL"
[ -n "${DOMAIN:-}" ] || printf '第一次打开浏览器会提示证书不受信任（自签证书），点“继续访问”即可；有域名后再运行本命令加上 DOMAIN=你的域名 就是正式证书。\n'
printf '请在服务器防火墙 / 云厂商安全组放行端口：%s\n' "$PORTS"
printf '加密口令在 %s，换服务器时需一并迁移。查看日志：journalctl -u investment-dashboard -f\n' "$ENVFILE"
