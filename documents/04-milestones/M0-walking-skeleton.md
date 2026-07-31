# M0: 行走骨架（Walking Skeleton）

目标：让"契约→实现→验证"的流水线先于任何功能存在。M0 完成前不分发功能卡。

## 交付清单
1. **项目骨架**：`pyproject.toml`（唯一依赖白名单）、目录结构、uv.lock。
2. **CI 流水线**（GitHub Actions）：lint（ruff）、format-check、check-deps、typecheck（mypy strict）、test（pytest + coverage）、build（Nuitka 冒烟）。
3. **pydantic 契约模型**：02-contracts → src/app/models，防漂移校验。
4. **共享工具**：事件总线（单一原始流扇出）、编码检测/转换、全局配置管理。
5. **主窗口骨架**：侧边导航 + 页面路由 + 状态栏。
6. **DPG 终端渲染 spike**（ADR-0017）：60fps 彩色滚动终端 + CJK 对齐 + 框线覆盖 + 维护状态验证。

## 退出标准
- 全部 CI 任务在主干绿。
- DPG spike 结论写入 ADR-0017（accepted 或触发变更）。
- 一个故意违反契约的演练 PR 被 check-deps/漂移校验拦截（流程验证）。
- README/AGENTS.md 必读路径在新会话代理上冒烟（给一个代理一个任务，确认其能自举开工）。

**R0 门：M0 达成前，任何业务模块零开工。**
