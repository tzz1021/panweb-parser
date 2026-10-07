#!/usr/bin/env bash
# ============================================================================
# panhub_praser 自托管引导（docs/backend-wrangler-plan.md §6，v1.2.2）
#
#   用法：./scripts/selfhost.sh [--help]
#   纯 bash + curl/tar（不需要 node/git）。从 GitHub codeload tarball 拉取源码。
#
#   选择题 1 —— 拉取范围
#     y        完整源码（含 SPA 前端源码）
#     回车     管理端 = docs + backend + functions + scripts（默认）
#              ★ 管理端不含 SPA —— SPA 走 CF/GitHub CDN 加载，不本地托管
#              ★ functions 必须带：functions/api/proxy.js 是唯一转发实现，缺了 hop 直接 502
#   选择题 2 —— 目标目录已有必要源码时，是否拉取最新并逐个覆盖写入（默认 是）
#     覆盖只动归档内的文件；backend/data 与 .dev.vars 不在归档，天然保留
#
#   下载：codeload tarball 优先（免登录免 git 协议），ghproxy 类镜像兜底；
#   测速：下载前 range 探测打印下载速度；
#   校验：sha256 打印（与发布说明核对）。
#   输出目录：$WORK_DIR（默认 ~/panhub_praser，可用环境变量 WORK_DIR 覆盖）
# ============================================================================
set -euo pipefail

REPO="tzz1021/panweb-parser"
BRANCH="master"
REPO_URL="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"
MIRROR_PREFIXES=(
  "https://ghproxy.net/"
  "https://mirror.ghproxy.com/"
)
WORK_DIR="${WORK_DIR:-$HOME/panhub_praser}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'

info() { echo "${C_CYAN}[selfhost]${C_RESET} $*"; }
ok()   { echo "${C_GREEN}[selfhost]${C_RESET} $*"; }
warn() { echo "${C_YELLOW}[selfhost]${C_RESET} $*" >&2; }
fail() { echo "${C_RED}[selfhost]${C_RESET} $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1（请先安装，或确认 PATH）"; }

usage() {
  cat <<'EOF'
panhub_praser 自托管引导（docs/backend-wrangler-plan.md §6，v1.2.2）

用法: ./scripts/selfhost.sh [--help]

交互:
  选择题 1 — 拉取范围
    y          完整源码（含 SPA 前端源码）
    （回车）   管理端 = docs + backend + functions + scripts（默认）
               ★ 管理端不含 SPA（SPA 走 CF/GitHub CDN，不本地托管）
               ★ functions 必须带（functions/api/proxy.js 是唯一转发实现）
  选择题 2 — 目标目录已有必要源码时，是否拉取最新并逐个覆盖写入（默认 是）
               覆盖只动归档内的文件；backend/data 与 .dev.vars 不在归档，天然保留

下载: codeload tarball 优先（免登录免 git 协议），ghproxy 镜像兜底；sha256 校验
输出: $WORK_DIR（可用环境变量 WORK_DIR 覆盖）
EOF
}

sha256_of() {  # $1=file → 打印 sha256
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "缺少 sha256sum / shasum（请安装 coreutils 或 openssl）"
  fi
}

# 下载一个 URL 到 $TMP_DIR/source.tar.gz；成功返回 0。下载前先 range 测速打印速度。
fetch_tarball() {
  local url="$1" out="$TMP_DIR/source.tar.gz" speed
  if speed="$(curl -fsSL --max-time 15 -r 0-1048575 -o "$TMP_DIR/speed.bin" -w '%{speed_download}' "$url" 2>/dev/null)"; then
    local kb; kb="$(awk -v s="$speed" 'BEGIN{printf "%.0f", s/1024}')"
    ok "测速 ${url%%tar.gz*}：${kb} KB/s"
  else
    warn "测速失败（源不支持 range 或网络异常），直接下载"
  fi
  info "下载 ${url} …"
  curl -fL --max-time 900 --progress-bar -o "$out" "$url"
}

# 按选择检查目标目录是否已有必要源码
dirs_present() {
  local d
  if [ "$SCOPE" = "full" ]; then
    [ -d "$WORK_DIR/backend" ] && [ -d "$WORK_DIR/src" ] && [ -f "$WORK_DIR/package.json" ]
  else
    for d in backend docs functions scripts; do
      [ -d "$WORK_DIR/$d" ] || return 1
    done
  fi
}

# 从解压目录按选择覆盖写入 $WORK_DIR（cp -a 合并；不删目标里归档外的东西 ——
# backend/data 与 .dev.vars 不在归档，天然保留）
copy_selected() {
  local SRC_DIR="$1" d
  if [ "$SCOPE" = "full" ]; then
    info "覆盖写入完整源码 → $WORK_DIR"
    cp -a "$SRC_DIR/." "$WORK_DIR/"
  else
    for d in backend docs functions scripts; do
      [ -d "$SRC_DIR/$d" ] || fail "归档缺少 $d/（tarball 结构异常）"
      mkdir -p "$WORK_DIR/$d"
      info "覆盖写入 $d/ → $WORK_DIR/$d/"
      cp -a "$SRC_DIR/$d/." "$WORK_DIR/$d/"
    done
  fi
}

main() {
  case "${1:-}" in
    -h|--help|help) usage; exit 0 ;;
    "") : ;;
    *) warn "未知参数：$1"; usage; exit 1 ;;
  esac

  need_cmd curl
  need_cmd tar

  echo ""
  echo "${C_BOLD}══ panhub_praser 自托管引导（v1.2.2）══${C_RESET}"
  info "输出目录：$WORK_DIR"
  read -r -p "拉取范围？完整源码（y）/ 管理端 = docs+backend+functions+scripts（默认，直接回车）: " scope_ans
  case "$scope_ans" in
    y|Y|yes|YES)
      SCOPE="full"
      info "选择：完整源码（含 SPA 前端源码）"
      ;;
    *)
      SCOPE="admin"
      info "选择：管理端（docs + backend + functions + scripts）"
      info "★ 管理端不含 SPA —— SPA 走 CF/GitHub CDN 加载，不本地托管"
      info "★ B 端员工只拿 proxy_address + proxy_token（无管理面板令牌）"
      ;;
  esac

  if dirs_present; then
    echo ""
    read -r -p "检测到已有必要源码，是否拉取最新版本并逐个覆盖写入（不会影响仓库中不包含的文件）？[Y/n] " upd_ans
    case "$upd_ans" in
      n|N|no|NO)
        info "保持现有源码不变。"
        echo ""
        ok "必要资源在 $WORK_DIR 就绪"
        ok "使用文档在 $WORK_DIR/docs"
        ok "后端管理脚本在 $WORK_DIR/backend/launcher.sh"
        exit 0
        ;;
      *)
        info "选择：拉取最新并覆盖写入（backend/data 与 .dev.vars 不在归档，天然保留）"
        ;;
    esac
  else
    info "未检测到必要源码，开始拉取…"
  fi

  # 下载（codeload 优先，ghproxy 镜像兜底）
  local tarball="" p
  if fetch_tarball "$REPO_URL"; then
    tarball="$TMP_DIR/source.tar.gz"
  else
    warn "codeload 下载失败，尝试镜像…"
    for p in "${MIRROR_PREFIXES[@]}"; do
      info "尝试镜像：${p}${REPO_URL}"
      if fetch_tarball "${p}${REPO_URL}"; then
        tarball="$TMP_DIR/source.tar.gz"
        break
      fi
    done
  fi
  [ -n "$tarball" ] || fail "所有下载源均失败 —— 稍后重试，或手动下载 tarball 解压到 $WORK_DIR"

  echo ""
  info "校验 sha256…"
  local sum; sum="$(sha256_of "$tarball")"
  ok "sha256: ${C_BOLD}$sum${C_RESET}"
  info "请与发布说明 / README 中注明的 sha256 核对（一致再继续）"

  info "解压 tarball…"
  tar xzf "$tarball" -C "$TMP_DIR"
  local SRC_DIR="$TMP_DIR/${REPO##*/}-${BRANCH}"
  [ -d "$SRC_DIR" ] || fail "解压后未找到 $SRC_DIR（tarball 结构异常）"

  mkdir -p "$WORK_DIR"
  copy_selected "$SRC_DIR"

  echo ""
  ok "必要资源在 $WORK_DIR 就绪"
  ok "使用文档在 $WORK_DIR/docs"
  ok "后端管理脚本在 $WORK_DIR/backend/launcher.sh"
  echo ""
  info "下一步：cd $WORK_DIR && ./backend/launcher.sh setup && ./backend/launcher.sh start"
  info "（后端管理脚本需 node ≥ 22.5；SPA 无需本地托管，浏览器直接走 CDN）"
}

main "$@"
