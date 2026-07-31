# MAXCOM 地基模块（Foundation / T0）

> 状态：接近规格 ｜ **必须最先完成**
> **本模块存在的理由**：05-quality 的所有强制（lint/CI/test/技术栈锁）若没有真实落地就是空文。本模块把"把笼子建起来"显式化为一组 T0 任务，排在所有业务任务之前。所有 R7/R8/R3 的强制力都依赖本模块产物存在并接进 CI。

---

## 1. 定位

T0 = 项目第 0 步。产出 `src/` 代码骨架与强制基础设施（lint、CI、技术栈锁、共享工具、pydantic 模型）。完成后，任何业务模块 agent 一拉仓库，lint/类型/CI/共享工具/契约模型就都在位，无法绕过。

**铁律**：T0 全部完成并 CI 绿之前，**禁止任何业务模块（ansi/terminal/...）开工**。这是唯一的全局前置门。

## 2. 产出全景（实现仓结构）

```
src/
├── main.py                      # 入口（T0-T01）
├── app/
│   ├── __init__.py
│   ├── application.py           # 应用生命周期
│   ├── config.py                # 全局配置管理 (TOML + pydantic)
│   └── app_context.py           # 依赖注入容器
├── core/
│   ├── __init__.py
│   ├── transport/               # 传输抽象层（空壳，业务填充）
│   ├── pipeline/
│   │   ├── event_bus.py         # Pub/Sub 事件总线
│   │   └── encoding.py          # 编码检测与转换
│   ├── ansi/                    # （空壳，业务填充）
│   └── ...
├── ui/
│   └── main_window.py           # 主窗口 + 布局骨架
└── __init__.py
```

根目录：`pyproject.toml`（唯一依赖白名单）、`uv.lock`、`.github/workflows/ci.yml`、`.pre-commit-config.yaml`、`ruff.toml`、`mypy.ini`、`tools/`（脚本）。

## 3. 关键设计

### 3.1 技术栈锁的物理载体
`05-quality/tech-stack-lock.md` 的清单必须实体化为：
- `pyproject.toml` 的 dependencies 精确版本（锁版本，非 ^/~）。
- CI 跑 `check-deps`（扫 import，白名单外 = fail）。这样"禁止自己装库"才有牙齿。

### 3.2 共享工具（core/pipeline 基础）
T0 先把常用工具实现好并测试，否则业务 agent 会各写一份：
- `event_bus.py`：Pub/Sub 事件总线（单一原始流扇出，见 ADR-0015）。
- `encoding.py`：UTF-8/GBK/Latin-1 + 自动检测。
- `config.py`：全局配置 TOML + pydantic 校验。

### 3.3 契约模型
T0 把 `02-contracts` 的 schema 用 pydantic 定义同构模型（`src/app/models/`），作为业务模块的共享依赖。杜绝手写重复定义。

### 3.4 CI 门（总闸）
`.github/workflows/ci.yml` 必须包含、且任一红则阻断合并：
```
lint（ruff）                    ← R8
format-check（ruff format --check） ← R8
check-deps（白名单扫描）          ← R7
typecheck（mypy --strict）        ← R8
test（pytest + coverage）         ← R3/DoD
build（Nuitka 打包冒烟）          ← 交付
```

## 4. 任务卡（T0-T01 … T0-T08）

| 卡 | 标题 | blocked-by |
|---|---|---|
| T0-T01 | 项目骨架 + pyproject + CI | — |
| T0-T02 | lint/format/type 配置（ruff + mypy + pre-commit） | T0-T01 |
| T0-T03 | pydantic 契约模型（02-contracts → src/app/models） | T0-T01 |
| T0-T04 | 事件总线（单一原始流扇出）实现 + 测试 | T0-T01 |
| T0-T05 | 编码检测/转换实现 + 测试 | T0-T01 |
| T0-T06 | 全局配置管理（TOML + pydantic）+ 测试 | T0-T03 |
| T0-T07 | 主窗口骨架 + 侧边导航 + 状态栏 | T0-T01 |
| T0-T08 | DPG 终端渲染 spike（ADR-0017，开工前置验证） | T0-T07 |

## 5. 里程碑挂钩

**M-T0「笼子建成」**：`uv sync && uv run pytest` 全绿——lint/类型/check-deps/契约模型/测试/CI 骨架全部就位，共享工具可 import，pydantic 契约模型可 import，DPG spike 验证通过。**此里程碑达成前，业务模块零开工。**
