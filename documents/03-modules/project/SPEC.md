# Project 系统模块（project / PRJ）

> 状态：接近规格 ｜ 依赖：_foundation、transport、command
> 对应 V2 §6。.maxcomprj（ZIP）一键保存/恢复完整调试环境。单连接 + 多实例（ADR-0016）。

## 1. 定位
Project = 完整调试工作环境快照。切换项目 = 一键恢复所有配置（连接/命令/过滤/绘图/布局）。类比 IDE 的 Project 概念。

## 2. 组件

### 2.1 文件格式（project_file）
`.maxcomprj` 是 ZIP，内含：
```
project.toml / transport.toml / commands.json / filters.toml / plots/*.toml / view_state.toml / history/(空)
```
- **原子写**：临时文件 + rename，避免写坏（ADR-0004）。
- **导出文件夹**功能（供 Git 版本控制）。

### 2.2 生命周期（project_manager）
- 新建 / 打开 / 保存 / 另存为 / 自动保存（可配定时，防崩溃丢失）/ 最近项目。

### 2.3 会话恢复（session_manager）
- 打开项目 → 恢复配置 → 自动连接串口。
- 与全局配置关系：项目配置覆盖全局（优先级高）。

## 3. 关键不变量
- **INV-1**：保存用原子写（临时 + rename）。
- **INV-2**：项目配置覆盖全局配置。
- **INV-3**：单连接（一个实例一个项目），多实例各持独立项目（ADR-0016）。

## 4. 任务卡
| 卡 | 标题 | blocked-by |
|---|---|---|
| PRJ-T01 | .maxcomprj 读写（ZIP + TOML/JSON，原子写） | T0-T03 |
| PRJ-T02 | 生命周期（新建/打开/保存/另存为/自动保存/最近项目） | PRJ-T01 |
| PRJ-T03 | 会话恢复（打开→配置→自动连接） | PRJ-T02, TP-T02 |
| PRJ-T04 | 导出文件夹功能（Git 友好） | PRJ-T01 |
| PRJ-T05 | 配置优先级（项目覆盖全局） | PRJ-T01, T0-T06 |
