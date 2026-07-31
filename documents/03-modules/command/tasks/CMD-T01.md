# CMD-T01: 命令管理 + 快捷键

> 模块：command ｜ 依赖：T0-T03

## 目标
实现命令 CRUD/分组/导入导出/快捷键映射。命令条目结构来自 contracts。

## IMPL `[骨架]`

### 签名
```python
class CommandManager:
    def add(self, cmd: Command) -> None: ...
    def remove(self, name: str) -> None: ...
    def update(self, cmd: Command) -> None: ...
    def list(self, group: str | None = None) -> list[Command]: ...
    def set_shortcut(self, name: str, shortcut: str) -> None: ...
    def import_json(self, path: Path) -> None: ...
    def export_json(self, path: Path) -> None: ...
```

### 完成标准（DoD）
- [ ] CRUD + 分组
- [ ] 快捷键映射（无冲突校验）
- [ ] 导入导出 JSON（pydantic 校验）

## 禁止事项
- 命令数据与契约 schema 一致
