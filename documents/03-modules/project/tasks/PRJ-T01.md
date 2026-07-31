# PRJ-T01: .maxcomprj 读写（ZIP + 原子写）

> 模块：project ｜ 依赖：T0-T03

## 目标
实现 .maxcomprj（ZIP）读写：project/transport/commands/filters/plots/view_state，原子写（ADR-0004）。

## IMPL `[详细]`

### 签名
```python
class ProjectFile:
    def __init__(self, path: Path): ...
    def load(self) -> ProjectBundle:
        # 解 ZIP，读各子文件，pydantic 校验
    def save(self, bundle: ProjectBundle) -> None:
        # 写临时文件 → rename（原子）
    def export_dir(self, out_dir: Path) -> None: ...
        # 解包为目录（Git 友好）
    @dataclass
    class ProjectBundle:
        project: ProjectMeta
        transport: TransportConfig | None
        commands: list[Command] = []
        filters: list[FilterRule] = []
        plots: dict[str, PlotConfig] = {}
        view_state: ViewState | None = None
```

### 易错点
- **原子写**：写 `.maxcomprj.tmp` 再 rename，写坏不残留。
- 缺文件容错：部分缺失回退默认，不崩溃。
- 版本兼容：`project.version` 不匹配时提示/迁移。

### 完成标准（DoD）
- [ ] 保存 → 加载一致（round-trip）
- [ ] 原子写测试（模拟中断不残留损坏）
- [ ] 缺失文件回退默认
- [ ] 导出文件夹

## 禁止事项
- 不把运行时大数据（历史）强制写盘（history 预留空）
