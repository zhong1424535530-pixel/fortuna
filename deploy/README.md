# 部署到 Linux 服务器

服务只监听 `127.0.0.1:4173`，对外由 Caddy 提供 HTTPS；登录是“用户名 + 谷歌验证器动态码”。资料全部在 `/var/lib/investment-dashboard`（SQLite 单文件，无需另装数据库）。

## 1. 服务器准备（一次）

要求：Node.js ≥ 22.13（需要内置的 `node:sqlite`）、内存 ≥ 1 GB（并开启 swap）、已装 `caddy` 和 `rsync`。

```bash
sudo useradd --system --create-home --home-dir /opt/investment-dashboard --shell /usr/sbin/nologin investment
sudo install -d -o investment -g investment -m 700 /var/lib/investment-dashboard
```

## 2. 上传代码并构建

```bash
# 在本机
rsync -a --exclude node_modules --exclude dist --exclude .git ./ 用户@服务器:/tmp/investment-dashboard/
# 在服务器
sudo rsync -a /tmp/investment-dashboard/ /opt/investment-dashboard/ && sudo chown -R investment:investment /opt/investment-dashboard
cd /opt/investment-dashboard && sudo -u investment npm ci && sudo -u investment npm run build
```

## 3. 迁移现有资料（可选）

先在本机停掉服务（避免两边同时同步），再把资料目录整个传过去。交易所密钥在本机钥匙串里，不会跟着走，到服务器上重新填。

```bash
rsync -a "$HOME/Library/Application Support/PersonalInvestmentDashboard/" 用户@服务器:/tmp/investment-data/
# 在服务器（服务启动前）
sudo rsync -a /tmp/investment-data/ /var/lib/investment-dashboard/ && sudo chown -R investment:investment /var/lib/investment-dashboard
sudo -u investment env INVESTMENT_DATA_DIR=/var/lib/investment-dashboard npm run migrate:database -- --confirm
```

不迁移就直接跳过这一步：首次启动会在空目录里自动建库。

## 4. 配置并启动

```bash
sudo install -m 600 -o root deploy/env.example /etc/investment-dashboard.env
sudo nano /etc/investment-dashboard.env          # 填 INVESTMENT_MASTER_KEY（openssl rand -base64 32）
sudo cp deploy/investment-dashboard.service  /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now investment-dashboard

# 绑定谷歌验证器（扫终端里的二维码，输入 6 位数字确认）
sudo -u investment env INVESTMENT_DATA_DIR=/var/lib/investment-dashboard npm run auth:setup
```

HTTPS：把 `deploy/Caddyfile` 里的“服务器IP”改成公网 IP，放进 `/etc/caddy/Caddyfile`，`sudo systemctl reload caddy`，防火墙只放行 8443（有域名后放行 80 和 443）。访问 `https://服务器IP:8443`。

## 5. 上线验收

- [ ] `systemctl status investment-dashboard` 为 active，`journalctl -u investment-dashboard -n 50` 没有报错。
- [ ] 不登录直接访问 `https://服务器IP:8443/api/connections` 返回 401；登录后页面正常。
- [ ] 登录页输错动态码 5 次会被锁定。
- [ ] 在页面里重新填交易所密钥，并把服务器 IP 加进各平台密钥的 IP 白名单；只开读取权限。
- [ ] `sudo systemctl restart investment-dashboard` 之后密钥仍在、不用重新登录。
- [ ] `sudo kill -9 $(systemctl show -p MainPID --value investment-dashboard)` 之后 5 秒内自动拉起，页面仍能保存。
- [ ] 关掉网页等 5 分钟，再打开，净值走势没有断档。
- [ ] 在设置页点“导出备份”，把文件存到别处（服务器上没有自动备份，换机或重装全靠它）。

## 6. 日常

- 看日志：`journalctl -u investment-dashboard -f`。定时任务和接口失败都会写在这里（不含密钥和请求内容）。
- 更新代码：重复第 2 步，然后 `sudo systemctl restart investment-dashboard`。
- 加密口令 `INVESTMENT_MASTER_KEY` 要另外保管（密码管理器），不在备份里；丢失后重新填一遍交易所密钥即可。
- 手机丢了：在服务器上重新运行 `auth:setup`，所有已登录设备立刻退出。
- 数据保留：交易记录永久保留；净值走势 2 天内每分钟一个点、35 天内每小时、更早每天保留日初日末；三年约 100 MB。
