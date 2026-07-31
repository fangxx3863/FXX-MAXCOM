# 自动染色模块（colorize / COLOR）

> 状态：接近规格 ｜ 依赖：_foundation
> 对应 V2 §1.4。ANSI 解析器的**互补功能**：无 ANSI 时按预设规则给日志行着色；检测到 ANSI 自动让位。

## 1. 定位
当数据流不含 ANSI 颜色代码（多数裸机/RTOS 场景），自动染色引擎按预设规则给日志行着色。当检测到 ANSI 序列时自动让位，不叠加处理（ADR-0013）。

## 2. 组件

### 2.1 规则链（engine）
按优先级首次匹配生效：
1. 日志等级括号 `[D][I][W][E][F]`（level=1）
2. 日志等级关键词 `DEBUG/INFO/WARN/ERROR/FATAL`（keyword=2）
3. 键值对 `KEY: VALUE` → 冒号后内容染色（kv=3）
4. 数值高亮 `0x..` / `\d+\.\d+` / `\d+`（number=4）
5. 用户自定义正则（priority 可配，可插到内置之前）

### 2.2 内置规则（builtin_rules）
- 等级括号/关键词/键值对/数值。每条独立开关。
- 颜色：D=灰, I=默认, W=黄, E=红, F=红+粗体。

### 2.3 用户规则（custom_rules）
- 从 `02-contracts/color-rule.schema.json` 定义（pattern/target/color/bold/priority）。

## 3. 关键不变量
- **INV-1**：数据含 ANSI 序列时自动染色**不插手**（ANSI 让位）。
- **INV-2**：每条规则可独立开关；总开关关闭则全部默认色。
- **INV-3**：先染色后过滤（颜色标签已附加，过滤不影响颜色）。

## 4. 任务卡
| 卡 | 标题 | blocked-by |
|---|---|---|
| COLOR-T01 | 规则链执行引擎（优先级 + 首次匹配） | T0 |
| COLOR-T02 | 内置规则：等级括号 | COLOR-T01 |
| COLOR-T03 | 内置规则：等级关键词 | COLOR-T01 |
| COLOR-T04 | 内置规则：键值对 + 数值高亮 | COLOR-T01 |
| COLOR-T05 | 用户自定义规则加载（契约）+ 独立开关 | COLOR-T01, T0-T03 |
| COLOR-T06 | ANSI 让位检测 + 总开关 | COLOR-T01 |
| COLOR-T07 | 颜色调色板（palette，含暗色主题适配） | COLOR-T01 |
