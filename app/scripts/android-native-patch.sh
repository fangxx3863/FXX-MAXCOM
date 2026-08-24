#!/usr/bin/env bash
# 安卓原生补丁：在 `npx tauri android init --ci` 生成的原生工程上就地打补丁。
# 解决三个只能在原生侧修复的问题（桌面端不受影响 —— 本脚本仅作用于安卓工程）：
#   1. 状态栏遮挡顶部功能键  -> 用固定 MainActivity.kt（挂 WindowInsets 监听把内容推回安全区）
#   2. 键盘弹起不缩小文字区  -> AndroidManifest <activity> 加 windowSoftInputMode="adjustResize"
#   3. APK 未签名            -> app/build.gradle.kts 的 release buildType 加 signingConfig
#
# 用法：cd app && bash scripts/android-native-patch.sh
# （CI 中在 `npx tauri android init --ci` 之后、`npx tauri android build --apk` 之前执行）
# 可用环境变量 GEN 覆盖安卓工程根目录（默认 src-tauri/gen/android）。
set -euo pipefail

GEN="${GEN:-src-tauri/gen/android}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -d "$GEN" ] || { echo "错误：未找到 $GEN —— 请先在 app 目录运行 npx tauri android init --ci"; exit 1; }

# 探测可用的 python：优先 python3（GitHub ubuntu-latest 标准名），无效则回退 python。
# 本机某些环境 python3 是打不开的占位 stub，须真正运行一次验证它可用。
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys' >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then echo "错误：未找到可用的 python（python3/python）"; exit 1; fi
echo ">> 使用解释器: $PY"

echo "== 安卓原生补丁：(1/3) 状态栏遮挡 -> 固定 MainActivity.kt（WindowInsets 安全区） =="
MAIN_ACT="$(find "$GEN" -path "*app/src/main/MainActivity.kt" | head -1)"
echo "   MainActivity: ${MAIN_ACT:-未找到}"
if [ -n "$MAIN_ACT" ]; then
  cp "$SCRIPT_DIR/android/MainActivity.kt" "$MAIN_ACT"
  echo "   已用固定版 MainActivity.kt 覆盖（挂 WindowInsets 监听，把内容推回状态栏安全区）"
else
  echo "   警告：未找到 MainActivity.kt，跳过状态栏修复"
fi

echo "== 安卓原生补丁：(2/3) 键盘 resize -> 加 windowSoftInputMode =="
MANIFEST="$(find "$GEN" -path "*app/src/main/AndroidManifest.xml" | head -1)"
echo "   Manifest: ${MANIFEST:-未找到}"
if [ -n "$MANIFEST" ]; then
  "$PY" - "$MANIFEST" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
if "windowSoftInputMode" in s:
    print("   已含 windowSoftInputMode，跳过")
else:
    s2 = re.sub(
        r'(<activity\b[^>]*android:exported="true")',
        r'\1\n            android:windowSoftInputMode="adjustResize"',
        s, count=1,
    )
    if s2 == s:
        print("   警告：未找到 <activity android:exported=\"true\">，请检查 manifest")
    else:
        open(p, "w", encoding="utf-8").write(s2)
        print('   已注入 android:windowSoftInputMode="adjustResize"（键盘弹起时窗口缩小，文字区随之收缩）')
PY
else
  echo "   警告：未找到 AndroidManifest.xml，跳过键盘修复"
fi

echo "== 安卓原生补丁：(3/3) 签名 -> release 加 signingConfig =="
GRADLE="$(find "$GEN" -path "*app/build.gradle.kts" | head -1)"
echo "   Gradle: ${GRADLE:-未找到}"
if [ -n "$GRADLE" ]; then
  "$PY" - "$GRADLE" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
if "signingConfig" in s:
    print("   已含 signingConfig，跳过")
else:
    # 在 release buildType 块内注入 debug 签名，使 release APK 被签名、可安装。
    # AGP 会在首次构建时自动生成 ~/.android/debug.keystore，无需提交任何密钥。
    # 若要发布到应用商店/滚动升级，请替换为正式 keystore：
    #   在 workflow 设置 ANDROID_KEYSTORE_* 密钥，并改用 signingConfigs.create(...) 读取之。
    s2 = re.sub(
        r'(\n(\s*)getByName\("release"\) \{\n)',
        lambda m: m.group(1) + m.group(2) + '    signingConfig = signingConfigs.getByName("debug")\n',
        s, count=1,
    )
    if s2 == s:
        print("   警告：未找到 getByName(\"release\") 块，请检查 build.gradle.kts")
    else:
        open(p, "w", encoding="utf-8").write(s2)
        print('   已为 release 注入 signingConfig = signingConfigs.getByName("debug")（APK 已签名、可安装）')
PY
else
  echo "   警告：未找到 app/build.gradle.kts，跳过签名修复"
fi

echo "== 安卓原生补丁完成 =="
