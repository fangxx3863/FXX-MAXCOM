# PRJ-T02: Project 生命周期

> 模块：project ｜ 依赖：PRJ-T01

## 目标
实现 Project 生命周期：新建/打开/保存/另存为/自动保存（可配定时）/最近项目。

## IMPL `[骨架]`

### 签名
```python
class ProjectManager:
    def new_project(self, transport_type: TransportType) -> Project: ...
    def open(self, path: Path) -> Project: ...
    def save(self) -> None: ...
    def save_as(self, path: Path) -> None: ...
    def set_autosave(self, interval_s: int | None) -> None: ...
    def recent_projects(self) -> list[Path]: ...
```

### 完成标准（DoD）
- [ ] 新建/打开/保存/另存为
- [ ] 自动保存定时（崩溃防丢）
- [ ] 最近项目列表（全局配置）

## 禁止事项
- 自动保存不阻塞 GUI（后台定时器）
