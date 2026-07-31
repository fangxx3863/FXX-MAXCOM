# 术语表

命名以此表为准。文档可中文，术语首次出现附英文。

| 术语 | 英文 | 说明 |
|---|---|---|
| **MAXCOM** | MAXCOM | 产品代号，正式名待定 |
| 交互式终端 | Interactive Terminal | 模式 A：完整 ANSI 渲染，击键直传，可操作 Linux 板卡 |
| 传统收发 | Log View + Send Panel | 模式 B：接收区（时间戳/染色/过滤）+ 发送区（命令/定时/校验） |
| 双模式 | Dual Mode | 侧边栏切换页面，连接不断，两套缓冲区后台同时运行 |
| 原始字节流 | Raw Byte Stream | 事件总线扇出给各引擎的同一份未处理数据（ADR-0015） |
| 引擎 | Engine | 消费原始流的独立解析器（终端/日志/绘图/文件），各跑自己的线程 |
| 智能分包 | Smart Framing | 按空闲超时切分数据帧，每帧一个时间戳；独立开关 |
| 时间戳 | Timestamp | 绝对 `HH:MM:SS.ms` / 相对 `+ms` / 差值 `Δms` 三种格式 |
| 自动染色 | Colorize | 无 ANSI 时按规则给日志行着色；检测到 ANSI 自动让位 |
| ANSI 让位 | ANSI Yield | 数据流含 ANSI 序列时，自动染色不插手，交由 ANSI 解析器 |
| 屏幕缓冲区 | ScreenBuffer | 带样式属性的二维字符网格，终端状态载体 |
| 回滚缓冲区 | Scrollback Buffer | 被滚出屏幕的行缓存，可上滚查看，不影响终端状态 |
| 击键直传 | Key Passthrough | 每次按键直接发送到串口，由远端控制回显 |
| 本地回显 | Local Echo | 远端不回显时本地同步显示输入（可选开关） |
| 空闲分包超时 | Idle Timeout | 分包的空闲阈值（10ms~500ms），可配置 |
| 过滤引擎 | Filter Engine | 按规则显示/隐藏日志行 |
| 日志等级 | Log Level | `[D] [I] [W] [E] [F]` 等，自动染色/过滤的依据 |
| 数据错位跳过 | Byte Skip | 绘图解析器本地游标跳过1字节重新对齐帧头（不影响其他引擎） |
| 环形缓冲区 | Ring Buffer | 绘图数据缓存，可配置点数 |
| 通道 | Channel | 绘图中的一个数据维度，可独立设置颜色/名称/过滤 |
| FFT | Fast Fourier Transform | 快速傅里叶变换，用于频谱显示 |
| Bode 图 | Bode Plot | 幅频/相频谱显示（此处为 FFT 频谱，非控制论频响曲线） |
| 统计仪表盘 | Statistics Dashboard | 均值/标准差/方差/峰峰值/RMS/PPM 等实时指标 |
| 传输层 | Transport | 串口/TCP/UDP/WINUSB/HID 的抽象接口 |
| 传输管理器 | Transport Manager | 发现、枚举、生命周期管理 |
| 端口别名 | Port Alias | 用户为端口自定义名称，持久化保存 |
| 端口黑名单 | Port Blacklist | 屏蔽不需要的端口（如蓝牙串口） |
| 热插拔检测 | Hotplug Detection | 设备插拔自动刷新列表 |
| 自动重连 | Auto Reconnect | 端口断开后自动重连 |
| 自定义命令 | Command | 预设命令，可分组/快捷键/变量替换/定时/自动校验 |
| 变量替换 | Variable Substitution | `{TIMESTAMP}` `{COUNTER}` `{HEX:xx}` 等 |
| Project 系统 | Project System | `.maxcomprj`（ZIP）保存/恢复完整调试环境 |
| 全局配置 | Global Config | 用户级配置（主题/语言/字体），`%APPDATA%/MAXCOM/` |
| 插件 | Plugin | 传输/协议/可视化/处理器/导出器扩展 |
| 双缓冲 | Double Buffering | 引擎线程写，GUI 主线程每 ~16ms 读快照 |
| 多实例 | Multi-instance | 通过启动多个应用实例满足多端口需求（ADR-0016） |
