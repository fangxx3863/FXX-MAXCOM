# 命令系统模块（command / CMD）

> 状态：接近规格 ｜ 依赖：_foundation、transport（SendPath）
> 对应 V2 §1.6 + §1.9。自定义命令：命令列表/快捷发送/变量替换/命令链/定时发送/自动校验。

## 1. 定位
自定义命令系统：预设命令分组管理，点击/快捷键发送。含定时发送、自动校验（CRC/Checksum/XOR）、变量替换、命令链、发送历史。

## 2. 组件

### 2.1 命令管理（command_manager）
- 增删改查、分组、导入导出。
- 命令条目结构（contracts:command.schema.json）：name/group/data/format/shortcut/repeat/expect/timeout_ms。
- 快捷键映射。

### 2.2 命令执行（command_executor）
- 点击/快捷键发送命令。
- 定时发送（repeat：count + interval_ms）。
- 命令链（多条按顺序/间隔发送，P1）。
- 响应等待（P2，**冻结为"发送后读一次匹配"极简版**，见 O7）。

### 2.3 变量替换（variables）
- `{TIMESTAMP}` `{COUNTER}` `{HEX:xx}` 等。

### 2.4 自动校验（protocol/checksum）
- CRC8/CRC16/CRC32/Checksum/XOR，自动追加。与绘图自定义帧校验可复用（protocol/checksum）。

## 3. 关键不变量
- **INV-1**：命令发送走统一发送路径（SendPath，TP-T08），不绕过。
- **INV-2**：变量替换在发送时求值，不改存储的命令。
- **INV-3**：校验追加后不改用户原始输入（显示追加值）。

## 4. 任务卡
| 卡 | 标题 | blocked-by |
|---|---|---|
| CMD-T01 | 命令管理（CRUD/分组/导入导出）+ 快捷键 | T0-T03 |
| CMD-T02 | 命令执行（点击/快捷键发送）+ 定时发送 | CMD-T01, TP-T08 |
| CMD-T03 | 变量替换引擎 | CMD-T01 |
| CMD-T04 | 自动校验（CRC/Checksum/XOR） | T0-T03 |
| CMD-T05 | 命令链 + 发送历史 | CMD-T02 |
| CMD-T06 | 响应等待（极简版，O7 待确认） | CMD-T02 |
