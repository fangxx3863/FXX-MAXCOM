# ADR-0011: CI/CD — GitHub Actions + uv

状态: accepted | 日期: 2026-07-31

## 背景
需要自动化保证代码质量、跨环境可复现、可交付 Windows 独立可执行文件。

## 决策
CI/CD 用 **GitHub Actions**，Windows runner，`uv` 管理依赖（`uv sync` / `uv.lock`）。流水线：lint（ruff）→ test（pytest + coverage）→ build（Nuitka 打包 .exe）。每次 push 和 PR 触发。

## 理由
- Windows 是目标平台，runner 直接跑在 windows-latest。
- uv 快且锁文件保证 CI 与本地一致。

## 后果
- 流水线含三条 job：lint / test / build（build 依赖前两者通过）。
- 虚拟串口集成测试需在 CI 中安装 com0com（见 05-quality/testing-strategy.md）。
