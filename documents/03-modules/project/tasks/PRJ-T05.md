# PRJ-T05: 配置优先级（项目覆盖全局）

> 模块：project ｜ 依赖：PRJ-T01, T0-T06

## 目标
实现配置优先级：项目配置覆盖全局配置（ADR：优先级 项目 > 全局）。

## IMPL `[骨架]`

### 签名
```python
def resolve(global_cfg: GlobalConfig, project_cfg: ProjectBundle) -> ResolvedConfig:
    # 合并：项目有值则用项目，否则全局兜底
```

### 完成标准（DoD）
- [ ] 项目配置覆盖全局
- [ ] 未配置项回退全局

## 禁止事项
- 全局不放项目相关配置（连接/命令/过滤/绘图）
