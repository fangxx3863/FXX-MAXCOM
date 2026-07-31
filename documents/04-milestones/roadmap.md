# 里程碑路线图

里程碑按「端到端可演示」切片，每个里程碑是跨模块的强制汇合点。里程碑文档必须包含可执行的验收演示脚本。

| 里程碑 | 名称 | 内容 | 涉及任务 |
|---|---|---|---|
| M0 | 骨架 + DPG spike | 项目骨架、CI、技术栈锁、pydantic 契约、事件总线、编码、全局配置、主窗口侧边导航、**DPG 终端渲染 spike**（ADR-0017） | T0-T01..T0-T08 |
| M1 | 终端核心 | ANSI 解析 + 屏幕缓冲 + 交互式终端渲染 + 击键直传 + 本地回显；传统收发（智能分包/时间戳/染色/过滤/分行）；侧边栏切换 | ANS 全部；TERM 全部；COLOR 全部；FLT 全部；LOG-T01..03 |
| M2 | 绘图引擎 | 数据源 + 帧解析（Simple Binary/ASCII/自定义帧）+ 跳过对齐 + 波形/柱状 + 通道 + FFT + 统计仪表盘 | PLT 全部 |
| M3 | Project + 命令 + 网络 | .maxcomprj 读写 + 生命周期；命令系统；TCP/UDP；XYZmodem；文件保存/发送 | PRJ 全部；CMD 全部；TP-T01/06/07；LOG-T06 |
| M4 | 完善优化 | 插件系统；WINUSB/HID；自动重连；主题；多语言；性能 | TP-T04/05；O 各待确认项 |
| M5 | 测试发布 | 补单元/集成测试；Nuitka 打包；文档；Beta | 全部收尾 |

进度门：M(n) 验收脚本未通过前，不向 M(n+1) 分发任务（防止在错误地基上并行扩张）。**M0 的 DPG spike 未通过前，不进入 M1**（ADR-0017）。

## 里程碑文档
- [M0: 行走骨架](M0-walking-skeleton.md)
- [M1: 终端核心](M1-terminal-core.md)
- [M2: 绘图引擎](M2-plot-engine.md)
- [M3: Project + 命令 + 网络](M3-project-command-network.md)
- [M4: 完善优化](M4-polish.md)
- [M5: 测试发布](M5-test-release.md)
