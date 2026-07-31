# PRJ-T04: 导出文件夹功能

> 模块：project ｜ 依赖：PRJ-T01

## 目标
把 .maxcomprj 解包为明文目录（供 Git 版本控制），并支持从目录重新打包。

## IMPL `[骨架]`

### 签名
```python
def export_dir(proj: ProjectFile, out_dir: Path) -> None: ...
def import_dir(proj: ProjectFile, src_dir: Path) -> None: ...
```

### 完成标准（DoD）
- [ ] 导出目录结构正确（project/transport/commands/filters/plots/view_state）
- [ ] 目录可重新打包回 .maxcomprj

## 禁止事项
- 导出不改变内部数据格式
