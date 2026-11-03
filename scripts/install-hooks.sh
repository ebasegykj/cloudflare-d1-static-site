#!/bin/sh
# 启用本仓库的提交检查钩子（每个 clone 各跑一次）
#   bash scripts/install-hooks.sh
# 取消：
#   git config --unset core.hooksPath

set -e
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# Unix 上 hook 必须可执行，否则 git 直接忽略；Windows 不受影响
chmod +x scripts/git-hooks/pre-commit scripts/git-hooks/pre-push 2>/dev/null || true

git config core.hooksPath scripts/git-hooks

echo "已启用提交检查"
echo "  core.hooksPath = scripts/git-hooks"
echo ""
echo "生效规则："
echo "  - 提交时暂存了 data/ 下的数据文件  → 拒绝"
echo "  - 提交或推送时本地落后 origin/main → 拒绝，提示先 pull --rebase"
echo ""
echo "紧急放行（极少用）：ALLOW_DATA_COMMIT=1 git commit ..."
