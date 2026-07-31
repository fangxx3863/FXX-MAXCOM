# M5: 测试发布

目标：补齐测试，Nuitka 打包，Beta 发布。

## 交付清单
1. **单元测试补全**：ANSI parser / ScreenBuffer / Filter / Colorize / Plot parsers / Checksum / Timestamp / ProjectFile（覆盖 ≥80%）。
2. **集成测试**：虚拟串口（com0com）loopback、TCP loopback。
3. **Nuitka 打包**：独立 .exe。
4. **用户文档**。
5. **Beta 发布**。

## 退出标准
- CI 全绿，覆盖率达标。
- 打包 .exe 可独立运行（无 Python 环境）。
- Beta 发布渠道就绪。
