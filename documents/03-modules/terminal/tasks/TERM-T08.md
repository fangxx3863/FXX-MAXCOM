# TERM-T08: 终端回滚搜索（O6 待确认）

> 模块：terminal ｜ 依赖：TERM-T06 ｜ 状态：待确认（O6，倾向补）

## 目标
在回滚缓冲中搜索文本，高亮命中并跳转。（O6 尚未拍板——若确认不做，本任务卡删除。）

## IMPL `[骨架]`

### 签名
```python
def search(self, query: str) -> Iterator[tuple[int,int]]: ...
    # 返回命中位置（行偏移 + 列）
def highlight_match(self, pos) -> None: ...
```

### 完成标准（DoD）
- [ ] 搜索命中高亮 + 跳转
- [ ] 跨 CJK 搜索不截半字符

## 禁止事项
- 搜索只读回滚区，不改数据
