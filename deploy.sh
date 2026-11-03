#!/usr/bin/env bash
# deploy.sh —— 确保「仓库最新代码已经真正部署到线上」
#
# 用法（在仓库根目录执行）：
#   bash deploy.sh               比对线上与 HEAD；已是最新就什么都不做，否则空提交触发部署并等待
#   bash deploy.sh --check       只比对，不推送（想知道"有没有部署到位"用它）
#   bash deploy.sh --force       跳过比对，直接空提交触发一次部署
#   bash deploy.sh --file=路径   指定用于比对的线上文件（默认 admin.js）
#
# 为什么需要它：Pages 偶尔会漏掉 main 的自动部署，而 CF 后台的「重试部署」只会
# 重跑那一次旧提交的构建、不拉最新代码。空提交（git commit --allow-empty）不改任何
# 文件、不碰数据，但会触发一次全新构建，拉的是当前最新代码。
set -uo pipefail

cd "$(dirname "$0")" || exit 1
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "✗ 当前目录不是 git 仓库"; exit 1; }
cd "$ROOT" || exit 1

FORCE=0
CHECK_ONLY=0
TARGET=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --check|--dry-run) CHECK_ONLY=1 ;;
    --file=*) TARGET="${a#--file=}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$a（可用 --force / --check / --file=路径）"; exit 1 ;;
  esac
done

# ---------- 站点配置 ----------
# 默认占位域名；在仓库根建一个 deploy.env（已被 .gitignore 忽略的话请自行忽略）
# 写 DEPLOY_BASE=https://你的站点.pages.dev，或直接改下面这一行。
if [ -f deploy.env ]; then . ./deploy.env; fi
SITE="${DEPLOY_SITE:-模板站}"
BASE="${DEPLOY_BASE:-https://your-site.pages.dev}"
DEF_FILE="assets/admin.js"
[ -n "$TARGET" ] || TARGET="$DEF_FILE"

# ---------- 工具函数 ----------
sha_stream() { sha256sum | awk '{print $1}'; }
online_sha() {  # 加随机参数绕过 CDN 缓存
  curl -fsS --max-time 25 "$BASE/$1?__ds=$(date +%s%N)" 2>/dev/null | sha_stream
}
local_sha() { git show "HEAD:$1" 2>/dev/null | sha_stream; }

echo "站点：$SITE"
echo "比对：$BASE/$TARGET"

git cat-file -e "HEAD:$TARGET" 2>/dev/null || {
  echo "✗ 仓库 HEAD 里没有 $TARGET，用 --file= 指定一个线上真实存在的文件"; exit 1
}
LS=$(local_sha "$TARGET")
OS=$(online_sha "$TARGET")

if [ -n "$OS" ] && [ "$OS" = "$LS" ]; then
  echo "✓ 线上已是最新（与仓库 HEAD 一致：$(echo "$LS" | cut -c1-10)）"
  if [ "$FORCE" != "1" ]; then
    echo "  无需操作。若要强制重跑一次构建：bash deploy.sh --force"
    exit 0
  fi
  echo "  --force：仍然触发一次部署"
else
  echo "… 不一致（线上 $(echo "${OS:-取不到}" | cut -c1-10) / 仓库 $(echo "$LS" | cut -c1-10)）"
  if [ "$CHECK_ONLY" = "1" ]; then
    echo "→ 需要触发部署：bash deploy.sh"
    exit 0
  fi
fi
[ "$CHECK_ONLY" = "1" ] && exit 0

# ---------- 工作区必须干净（避免空提交把别人的改动落下） ----------
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 有未提交的改动，先提交或 git stash 再跑（本脚本只做空提交，不代你决定提交什么）"
  git status --short | head -10
  exit 1
fi

echo "→ 拉取远端最新…"
git pull --rebase --quiet 2>/dev/null || true

echo "→ 推送空提交触发部署…"
git commit --allow-empty -m "触发 Pages 部署（deploy.sh，空提交）" >/dev/null || exit 1
OK=0
for i in 1 2 3; do
  if git push --quiet 2>/dev/null; then OK=1; break; fi
  echo "  push 失败，${i}0 秒内重试（$i/3）——代理偶发 502 属常见"
  sleep 10
done
if [ "$OK" != "1" ]; then
  echo "✗ push 失败：检查网络/代理后重试；本地已产生空提交，重跑本脚本会再提交一次（无害）"
  exit 1
fi

# ---------- 轮询线上是否已是新版 ----------
echo "→ 构建一般 60–120 秒，开始等待（最多 10 分钟，Ctrl+C 可中断）…"
START=$(date +%s)
for _ in $(seq 1 40); do
  sleep 15
  NOW=$(online_sha "$TARGET")
  if [ -n "$NOW" ] && [ "$NOW" = "$LS" ]; then
    echo "✓ 部署完成，用时 $(( $(date +%s) - START )) 秒"
    echo "  $BASE/$TARGET"
    exit 0
  fi
  echo "  已等 $(( $(date +%s) - START )) 秒…"
done

echo "✗ 10 分钟仍未生效。去 CF → Workers & Pages → 该项目 → Deployments 看最近一次构建"
echo "  若构建失败，日志里有原因；构建成功但内容没变，说明比对文件选错了，用 --file= 换一个"
exit 2
