# ADR-0007: 平台 — Phase 0-5 仅 Windows

状态: accepted | 日期: 2026-07-31

## 背景
目标用户以 Windows 为主（SSCOM/SuperCom 生态），但未来可能需支持 macOS/Linux。

## 决策
Phase 0-5 **仅 Windows**。架构保持**跨平台可移植性**：传输层抽象、数据管道、核心引擎不依赖 Windows 特定 API；仅 WINUSB 等 Windows 特性局部隔离。

## 理由
- 收窄首期平台，专注核心功能与 Windows 串口/网口调试体验。
- 跨平台抽象代价低，提前做避免后期重构。

## 后果
- 打包目标为 Windows 独立 .exe（Nuitka）。
- 虚拟串口测试用 com0com（Windows 专用，见 05-quality/testing-strategy.md）。
