// 国际化：中 / 英 双语。静态标签（index.html）用 data-i18n / data-i18n-title /
// data-i18n-placeholder 属性 + applyStaticI18n() 一次性翻译；动态字符串（下拉选项、
// 状态提示、右键菜单等）统一走 t()。语言切换通过 setLang() 持久化并整页重载
// （标签页/设置已持久化，重载即完整恢复，无需就地重渲染）。
export type Lang = "zh" | "en";

const LANG_KEY = "maxcom.lang";
type Dict = Record<string, string>;

const zh: Dict = {
  // ── 通用 ──
  "common.ok": "确定",
  "common.clear": "清空",
  "common.add": "＋ 添加",
  "common.apply": "应用",
  "common.deleteRow": "删除本行",
  "panel.close": "关闭面板",
  "panel.resize": "拖拽调整宽度",

  // ── 标题栏 / 窗口 ──
  "tab.new": "新建标签页 (Ctrl+T)",
  "win.min": "最小化",
  "win.maxrestore": "最大化 / 还原",
  "win.close": "关闭",

  // ── 顶栏连接区 ──
  "conn.serial": "串口",
  "conn.tcp": "TCP 客户端",
  "conn.udp": "UDP",
  "conn.ssh": "SSH",
  "conn.telnet": "Telnet",
  "conn.rtt": "RTT",
  "conn.port.placeholder": "选择串口…",
  "conn.baud.placeholder": "波特率",
  "conn.host.placeholder": "主机",
  "conn.probe.placeholder": "选择探针…",
  "conn.chip.placeholder": "芯片",
  "conn.autoReconnect": "自动重连",
  "conn.connect": "连接",
  "conn.disconnect": "断开",
  "conn.noPort": "请先选择串口",
  "conn.connectError": "连接失败: {e}",
  "conn.dtr.error": "DTR 设置失败: {e}",
  "conn.rts.error": "RTS 设置失败: {e}",
  "conn.label.serial": "串口 {port} @ {baud}",
  "conn.label.rtt": "RTT {chip}#{up}",
  "conn.label.net": "{proto} {host}:{port}",
  "conn.label.sshUser": "{user}@{host}:{port}",

  // 串口更多设置
  "serial.more": "更多串口设置 ⚙",
  "serial.more.title": "数据位/停止位/校验/流控",
  "serial.setup.title": "串口设置",
  "serial.databits": "数据位",
  "serial.stopbits": "停止位",
  "serial.parity": "校验",
  "serial.flowctl": "流控",

  // SS/网络
  "tcp.port.placeholder": "端口",
  "ssh.user.placeholder": "用户名",
  "ssh.pass.placeholder": "密码(可选)",

  // RTT
  "rtt.up.placeholder": "UP通道",
  "rtt.up.title": "RTT up 通道（目标→主机，打印输出）",
  "rtt.down.placeholder": "DOWN通道",
  "rtt.down.title": "RTT down 通道（主机→目标，发送）",
  "rtt.addr.placeholder": "RTT地址(可选)",
  "rtt.addr.title": "RTT 控制块地址，留空自动扫描",
  "rtt.switchError": "切换 RTT 失败: {e}",

  // 探针 / 芯片
  "probe.enumerate.error": "探针枚举失败: {e}",
  "chip.auto": "自动检测",

  // 连接状态
  "state.connected": "已连接",
  "state.disconnected": "未连接",
  "state.error": "错误: {e}",
  "state.connectedWith": "已连接 {label}",

  // ── 刷新按钮 ──
  "refresh.ports": "刷新串口列表",
  "refresh.probes": "刷新探针列表",

  // ── 侧栏页面 ──
  "page.terminal": "终端",
  "page.terminal.title": "交互式终端",
  "page.logview": "收发",
  "page.logview.title": "传统收发",
  "page.plot": "绘图",
  "page.plot.title": "数据绘图",
  "page.stats": "统计",
  "page.stats.title": "统计仪表盘",
  "page.flash": "烧录",
  "page.flash.title": "烧录",
  "page.protocol": "协议",
  "page.protocol.title": "协议",
  "page.settings": "设置",
  "page.settings.title": "设置",

  // ── 日志控制条 ──
  "log.timestamp": "时间戳",
  "log.encoding": "编码",
  "log.idleTimeout": "分包超时(ms)",
  "log.hexDisplay": "HEX显示",
  "log.autoscroll": "自动滚动",
  "log.filter.placeholder": "过滤：仅显示匹配行",
  "log.filter.title": "支持正则（非法时按子串匹配），对新旧数据即时生效",
  "log.empty": "(空)",
  "log.multistr": "☰ 多字符串",
  "log.multistr.title": "多字符串/HEX 发送面板",
  "log.rules": "🎨 规则",
  "log.rules.title": "过滤与染色规则",
  "log.send.placeholder": "输入要发送的内容…\nEnter 换行 / Ctrl+Enter 发送 / ↑↓ 历史",
  "log.newline": "换行",
  "log.timer": "定时",
  "log.timer.ms": "定时发送间隔(ms)",
  "log.file": "发文件",
  "log.file.title": "分块发送文件原始字节",
  "log.file.progress": "发文件 {pct}%",
  "log.file.done": "文件已发送: {name} ({size} B)",
  "log.file.error": "发文件失败: {e}",
  "log.capture": "● 捕获",
  "log.capture.title": "捕获接收数据并保存为文件",
  "log.capture.stop": "■ 停止并保存",
  "log.capture.stopsize": "■ 停止并保存 ({size} KB)",
  "log.capture.saved": "已保存捕获 {size} B",
  "log.capture.savedPath": "已保存捕获 {size} B → {path}",
  "log.send.error": "发送失败: {e}",
  "log.send.main": "发送 Ctrl+↵",

  // 时间戳模式
  "ts.absolute": "绝对",
  "ts.relative": "相对",
  "ts.delta": "差值 Δ",
  "ts.none": "无",

  // 编码
  "encoding.auto": "自动",

  // 换行 / 发送模式
  "send.mode.text": "文本",
  "send.mode.hex": "HEX",
  "send.newline.none": "无换行",

  // ── 多字符串面板 ──
  "multistr.loop": "循环发送",
  "multistr.sent": "已发送: {content}",
  "multistr.hex.placeholder": "HEX 字节，如 13 00 FF",
  "multistr.text.placeholder": "字符串内容",
  "multistr.delay.title": "循环发送时本行之后的延时(ms)",
  "multistr.send": "发送",

  // ── 规则面板 ──
  "rules.filter": "过滤规则",
  "rules.userColor": "用户染色规则",
  "rules.colorMaster": "染色总开关",
  "rules.ansiYield": "ANSI 让位",
  "rules.hide": "隐藏",
  "rules.show": "显示",
  "rules.match": "命中段",
  "rules.line": "整行",
  "rules.color": "颜色",
  "rules.bold": "粗",
  "rules.filterRegex.placeholder": "正则，如 HEARTBEAT|DEBUG",
  "rules.colorRegex.placeholder": "正则，如 temp:\\s*\\d+",

  // ── 绘图页 ──
  "plot.format": "格式",
  "plot.channels": "通道数",
  "plot.dtype": "类型",
  "plot.endian": "端序",
  "plot.delimiter": "分隔符",
  "plot.delimiter.title": "列数由首行数据自动探测，列数变更自动跟随",
  "plot.split": "拆分",
  "plot.split.title": "分通道：第i列→第i通道；分包：整行=单通道样本序列，新行覆盖（如 FFT 数组打印）",
  "plot.frameHeader": "帧头(HEX)",
  "plot.frameHeader.title": "十六进制帧头，可含空格，如 AA BB",
  "plot.frameLen": "帧长",
  "plot.fixed": "定长",
  "plot.fixed.title": "载荷总字节数（不含帧头/长度/校验字节）",
  "plot.checksum": "校验",
  "plot.checksum.title": "载荷逐字节累加和（低8位），附于帧尾",
  "plot.view": "显示",
  "plot.layout": "布局",
  "plot.yRange": "Y轴范围",
  "plot.ymin.title": "Y 最小值",
  "plot.ymax.title": "Y 最大值",
  "plot.buffer": "X轴点数",
  "plot.buffer.title": "X 轴缓冲点数，改动即生效（会清空当前波形）",
  "plot.totalPoints": "总点数 {n}",
  "plot.chColor": "通道颜色",
  "plot.chShow": "显示通道",
  "plot.chGain": "增益",
  "plot.chOffset": "偏移",
  // 绘图格式选项
  "plot.fmt.ascii": "ASCII 分隔",
  "plot.fmt.binary": "Simple Binary",
  "plot.fmt.frame": "自定义帧",
  "plot.endian.little": "小端",
  "plot.endian.big": "大端",
  "plot.asplit.channel": "分通道",
  "plot.asplit.package": "分包·整行覆盖",
  "plot.frameLen.fixed": "定长字节",
  "plot.frameLen.payload": "首字节=长度",
  "plot.view.waveform": "波形图",
  "plot.view.bars": "垂直柱状",
  "plot.view.both": "同屏显示",
  "plot.layout.subplots": "分开子图",
  "plot.layout.overlay": "单图叠加",
  "plot.yrange.auto": "自动缩放",
  "plot.yrange.custom": "自定义…",

  // ── 统计页 ──
  "stats.title": "连接统计",
  "stats.channelsTitle": "通道指标（来自绘图引擎）",
  "stats.rxBytes": "RX 字节",
  "stats.txBytes": "TX 字节",
  "stats.rxRate": "RX 速率",
  "stats.txRate": "TX 速率",
  "stats.crcErrors": "CRC 错误",
  "stats.frameErrors": "帧错误",
  "stats.ch": "通道",
  "stats.current": "当前值",
  "stats.count": "样本数",
  "stats.mean": "均值",
  "stats.std": "标准差",
  "stats.variance": "方差",
  "stats.min": "最小",
  "stats.max": "最大",
  "stats.peakToPeak": "峰峰值",
  "stats.rms": "RMS",

  // ── 烧录页 ──
  "flash.title": "固件烧录",
  "flash.probe": "探针",
  "flash.chip": "芯片",
  "flash.firmware": "固件",
  "flash.format": "格式",
  "flash.binBase": "BIN 基址",
  "flash.binBase.placeholder": "留空=目标默认起始地址",
  "flash.file.placeholder": "选择 .elf / .hex / .bin / .uf2 固件",
  "flash.browse": "浏览…",
  "flash.verify": "烧录后校验",
  "flash.reset": "烧录后复位",
  "flash.do": "烧录",
  "flash.doRun": "烧录并打开 RTT",
  "flash.noFile": "请先选择固件文件",
  "flash.flashing": "正在烧录 {path} …",
  "flash.connectingRtt": "{msg}，正在连接 RTT…",
  "flash.error": "烧录失败: {e}",
  "flash.demoDone": "烧录完成（演示）: {chip}",
  "flash.filterFirmware": "固件",
  "flash.filterAll": "所有文件",

  // ── 协议页（Modbus RTU）──
  "protocol.notConnected": "未连接（请在顶部栏连接串口/网络）",
  "protocol.connected": "已连接（复用顶部栏连接）",
  "protocol.txBuf": "发送缓冲区",
  "protocol.rxBuf": "接收缓冲区",
  "protocol.clear": "清空数据",
  "protocol.slave": "485地址",
  "protocol.regAddr": "寄存器地址",
  "protocol.regCount": "寄存器个数",
  "protocol.read": "读取",
  "protocol.send": "发送",
  "protocol.coilValue": "线圈值",
  "protocol.regValue": "寄存器值",
  "protocol.regValues": "寄存器值(空格/逗号分隔)",
  "protocol.arbitrary": "任意指令",
  "protocol.arbitraryPlaceholder": "输入 HEX…",
  "protocol.crcSend": "CRC发送",
  "protocol.f01": "01指令（读线圈寄存器）",
  "protocol.f02": "02指令（读离散输入寄存器）",
  "protocol.f03": "03指令（读保持寄存器）",
  "protocol.f04": "04指令（读输入寄存器）",
  "protocol.f05": "05指令（写单个线圈寄存器）",
  "protocol.f06": "06指令（写单个保持寄存器）",
  "protocol.f10": "10指令（写多个保持寄存器）",
  "protocol.empty": "—",
  "protocol.invalidInput": "参数不合法",
  "protocol.respErr": "响应异常: {code}",
  "protocol.bitsResult": "位值({n}位): {bits}",
  "protocol.regsResult": "寄存器({n}个): {vals}",
  "protocol.unexpected": "非预期响应",
  "protocol.timeout": "等待响应超时",
  "protocol.sendError": "发送失败: {e}",
  "protocol.writeOk": "写入已确认: 地址={address} 值={value}",
  "protocol.writeMultiOk": "写入已确认: 起始={address} 个数={count}",
  "protocol.on": "开",
  "protocol.off": "关",
  "format.auto": "自动",
  "format.hex": "Intel HEX",

  // ── 设置页 ──
  "settings.appearance": "外观",
  "settings.reset": "恢复默认",
  "settings.reset.title": "恢复所有外观设置为默认值",
  "settings.hint": "设置即时生效并保存在浏览器本地。恢复默认可点击右上角按钮。",
  "settings.themeCard": "🎨 配色",
  "settings.theme": "配色方案",
  "settings.groupSystem": "系统",
  "settings.groupLight": "浅色",
  "settings.groupDark": "深色",
  "settings.groupColor": "彩色",
  "settings.themeNote": "选择“跟随系统”时会根据操作系统的深色/浅色模式自动切换。",
  "settings.logCard": "📄 收发区",
  "settings.logSize": "字体大小",
  "settings.logFamily": "字体",
  "settings.fontYahei": "微软雅黑（非等宽）",
  "settings.fontSystem": "系统默认（非等宽）",
  "settings.logNote": "影响日志视图与 HEX 显示的字体。",
  "settings.termCard": "⌨️ 终端",
  "settings.termSize": "终端字号",
  "settings.termNote": "xterm 终端模拟器的显示字号。",
  "settings.langCard": "🌐 语言",
  "settings.lang": "界面语言",
  "settings.langNote": "切换语言将刷新界面（标签页与设置会保留）。",
  "settings.chartCard": "📊 图表导出",
  "settings.chartStyle": "导出样式",
  "settings.chartStyleNote": "控制右键复制/导出的图表图像风格。",
  "chartstyle.theme": "跟随主题",
  "chartstyle.paper": "论文风格（白底）",
  "lang.zh": "中文",
  "lang.en": "English",

  // 主题选项
  "theme.system": "跟随系统",
  "theme.light": "浅色",
  "theme.solarLight": "Solarized 浅色",
  "theme.dark": "深色（默认）",
  "theme.midnight": "深色·午夜蓝",
  "theme.solar": "深色·Solarized",
  "theme.oled": "深色·OLED 纯黑",
  "theme.nord": "深色·Nord",
  "theme.dracula": "深色·Dracula",
  "theme.orange": "橙色",
  "theme.red": "红色",
  "theme.green": "绿色",
  "theme.pink": "粉色",
  "theme.purple": "紫色",

  // ── 状态栏 ──
  "sb.rate": "↓ {rx} KB/s ↑ {tx} KB/s",

  // ── 标签页 ──
  "tab.close": "关闭标签页 (Ctrl+W)",
  "tab.max": "最多 {n} 个标签页",
  "tab.newDefault": "新建 {n}",
  "tab.rename": "✏️ 重命名",
  "tab.rename.hint": "双击标签同样有效",
  "tab.duplicate": "🧬 复制标签页",
  "tab.duplicate.hint": "以当前配置新开一个标签",
  "tab.closeOther": "关闭其他标签页",
  "tab.closeRight": "关闭右侧标签页",
  "tab.closeItem": "✕ 关闭",

  // ── 右键菜单（编辑） ──
  "ctx.cut": "剪切",
  "ctx.copy": "复制",
  "ctx.paste": "粘贴",
  "ctx.paste.hint": "读取剪贴板文本插入光标处",
  "ctx.selectAll": "全选",

  // 绘图右键
  "ctx.copyPng": "📋 复制图表为 PNG",
  "ctx.copyPng.hint": "写入剪贴板；失败时转为下载",
  "ctx.exportCsv": "📄 导出 CSV",
  "ctx.exportCsv.all": "全部通道缓冲数据",
  "ctx.exportCsv.ch": "CH{n} 缓冲数据",

  // ── 终端页 ──
  "term.localEcho": "本地回显",
  "term.clear": "清屏",

  // ── 演示模式 ──
  "mock.busy": "已有活动连接（先断开再连）",
  "mock.notConnected": "未连接",
};

const en: Dict = {
  // ── Common ──
  "common.ok": "OK",
  "common.clear": "Clear",
  "common.add": "＋ Add",
  "common.apply": "Apply",
  "common.deleteRow": "Delete this row",
  "panel.close": "Close panel",
  "panel.resize": "Drag to resize",

  // ── Title bar / window ──
  "tab.new": "New tab (Ctrl+T)",
  "win.min": "Minimize",
  "win.maxrestore": "Maximize / Restore",
  "win.close": "Close",

  // ── Connection area ──
  "conn.serial": "Serial",
  "conn.tcp": "TCP Client",
  "conn.udp": "UDP",
  "conn.ssh": "SSH",
  "conn.telnet": "Telnet",
  "conn.rtt": "RTT",
  "conn.port.placeholder": "Select port…",
  "conn.baud.placeholder": "Baud",
  "conn.host.placeholder": "Host",
  "conn.probe.placeholder": "Select probe…",
  "conn.chip.placeholder": "Chip",
  "conn.autoReconnect": "Auto-reconnect",
  "conn.connect": "Connect",
  "conn.disconnect": "Disconnect",
  "conn.noPort": "Please select a port first",
  "conn.connectError": "Connect failed: {e}",
  "conn.dtr.error": "DTR set failed: {e}",
  "conn.rts.error": "RTS set failed: {e}",
  "conn.label.serial": "Serial {port} @ {baud}",
  "conn.label.rtt": "RTT {chip}#{up}",
  "conn.label.net": "{proto} {host}:{port}",
  "conn.label.sshUser": "{user}@{host}:{port}",

  "serial.more": "More serial settings ⚙",
  "serial.more.title": "Data bits / stop bits / parity / flow control",
  "serial.setup.title": "Serial settings",
  "serial.databits": "Data bits",
  "serial.stopbits": "Stop bits",
  "serial.parity": "Parity",
  "serial.flowctl": "Flow control",

  "tcp.port.placeholder": "Port",
  "ssh.user.placeholder": "Username",
  "ssh.pass.placeholder": "Password (optional)",

  "rtt.up.placeholder": "UP channel",
  "rtt.up.title": "RTT up channel (target → host, print output)",
  "rtt.down.placeholder": "DOWN channel",
  "rtt.down.title": "RTT down channel (host → target, send)",
  "rtt.addr.placeholder": "RTT addr (optional)",
  "rtt.addr.title": "RTT control block address; leave empty to auto-scan",
  "rtt.switchError": "Switch to RTT failed: {e}",

  "probe.enumerate.error": "Probe enumeration failed: {e}",
  "chip.auto": "Auto-detect",

  "state.connected": "Connected",
  "state.disconnected": "Disconnected",
  "state.error": "Error: {e}",
  "state.connectedWith": "Connected {label}",

  "refresh.ports": "Refresh serial ports",
  "refresh.probes": "Refresh probe list",

  "page.terminal": "Term",
  "page.terminal.title": "Interactive terminal",
  "page.logview": "Log",
  "page.logview.title": "Classic send/receive",
  "page.plot": "Plot",
  "page.plot.title": "Data plotting",
  "page.stats": "Stats",
  "page.stats.title": "Statistics dashboard",
  "page.flash": "Flash",
  "page.flash.title": "Flash",
  "page.protocol": "Protocol",
  "page.protocol.title": "Protocol",
  "page.settings": "Settings",
  "page.settings.title": "Settings",

  "log.timestamp": "Timestamp",
  "log.encoding": "Encoding",
  "log.idleTimeout": "Packet timeout(ms)",
  "log.hexDisplay": "HEX view",
  "log.autoscroll": "Auto-scroll",
  "log.filter.placeholder": "Filter: only show matching lines",
  "log.filter.title": "Supports regex (falls back to substring if invalid); applies to old and new data",
  "log.empty": "(empty)",
  "log.multistr": "☰ Multi-string",
  "log.multistr.title": "Multi-string / HEX send panel",
  "log.rules": "🎨 Rules",
  "log.rules.title": "Filter & color rules",
  "log.send.placeholder": "Type text to send…\nEnter = newline / Ctrl+Enter = send / ↑↓ = history",
  "log.newline": "Newline",
  "log.timer": "Timer",
  "log.timer.ms": "Timer interval(ms)",
  "log.file": "Send file",
  "log.file.title": "Send file raw bytes in chunks",
  "log.file.progress": "Sending file {pct}%",
  "log.file.done": "File sent: {name} ({size} B)",
  "log.file.error": "Send file failed: {e}",
  "log.capture": "● Capture",
  "log.capture.title": "Capture received data and save to file",
  "log.capture.stop": "■ Stop & save",
  "log.capture.stopsize": "■ Stop & save ({size} KB)",
  "log.capture.saved": "Saved capture {size} B",
  "log.capture.savedPath": "Saved capture {size} B → {path}",
  "log.send.error": "Send failed: {e}",
  "log.send.main": "Send Ctrl+↵",

  "ts.absolute": "Absolute",
  "ts.relative": "Relative",
  "ts.delta": "Delta Δ",
  "ts.none": "None",

  "encoding.auto": "Auto",

  "send.mode.text": "Text",
  "send.mode.hex": "HEX",
  "send.newline.none": "No newline",

  "multistr.loop": "Loop send",
  "multistr.sent": "Sent: {content}",
  "multistr.hex.placeholder": "HEX bytes, e.g. 13 00 FF",
  "multistr.text.placeholder": "String content",
  "multistr.delay.title": "Delay after this row when looping (ms)",
  "multistr.send": "Send",

  "rules.filter": "Filter rules",
  "rules.userColor": "User color rules",
  "rules.colorMaster": "Color master switch",
  "rules.ansiYield": "ANSI yield",
  "rules.hide": "Hide",
  "rules.show": "Show",
  "rules.match": "Matched segment",
  "rules.line": "Whole line",
  "rules.color": "Color",
  "rules.bold": "B",
  "rules.filterRegex.placeholder": "Regex, e.g. HEARTBEAT|DEBUG",
  "rules.colorRegex.placeholder": "Regex, e.g. temp:\\s*\\d+",

  "plot.format": "Format",
  "plot.channels": "Channels",
  "plot.dtype": "Type",
  "plot.endian": "Endian",
  "plot.delimiter": "Delimiter",
  "plot.delimiter.title": "Columns auto-detected from first data row; follows changes automatically",
  "plot.split": "Split",
  "plot.split.title": "Per-channel: col i → channel i; per-packet: whole row → single-channel sample sequence, new row overwrites (e.g. FFT array print)",
  "plot.frameHeader": "Header(HEX)",
  "plot.frameHeader.title": "Hex frame header, spaces allowed, e.g. AA BB",
  "plot.frameLen": "Frame len",
  "plot.fixed": "Fixed",
  "plot.fixed.title": "Total payload bytes (excluding header/length/checksum)",
  "plot.checksum": "Checksum",
  "plot.checksum.title": "Per-byte sum of payload (low 8 bits), appended to frame tail",
  "plot.view": "View",
  "plot.layout": "Layout",
  "plot.yRange": "Y range",
  "plot.ymin.title": "Y minimum",
  "plot.ymax.title": "Y maximum",
  "plot.buffer": "X points",
  "plot.buffer.title": "X-axis buffer points; applies immediately (clears current waveform)",
  "plot.totalPoints": "Total points {n}",
  "plot.chColor": "Channel color",
  "plot.chShow": "Show channel",
  "plot.chGain": "Gain",
  "plot.chOffset": "Offset",
  "plot.fmt.ascii": "ASCII delimited",
  "plot.fmt.binary": "Simple Binary",
  "plot.fmt.frame": "Custom frame",
  "plot.endian.little": "Little",
  "plot.endian.big": "Big",
  "plot.asplit.channel": "Per-channel",
  "plot.asplit.package": "Per-packet · row overwrite",
  "plot.frameLen.fixed": "Fixed bytes",
  "plot.frameLen.payload": "1st byte = length",
  "plot.view.waveform": "Waveform",
  "plot.view.bars": "Vertical bars",
  "plot.view.both": "Both",
  "plot.layout.subplots": "Separate subplots",
  "plot.layout.overlay": "Overlay",
  "plot.yrange.auto": "Auto-scale",
  "plot.yrange.custom": "Custom…",

  "stats.title": "Connection stats",
  "stats.channelsTitle": "Channel metrics (from plot engine)",
  "stats.rxBytes": "RX bytes",
  "stats.txBytes": "TX bytes",
  "stats.rxRate": "RX rate",
  "stats.txRate": "TX rate",
  "stats.crcErrors": "CRC errors",
  "stats.frameErrors": "Frame errors",
  "stats.ch": "Channel",
  "stats.current": "Current",
  "stats.count": "Samples",
  "stats.mean": "Mean",
  "stats.std": "Std dev",
  "stats.variance": "Variance",
  "stats.min": "Min",
  "stats.max": "Max",
  "stats.peakToPeak": "Peak-peak",
  "stats.rms": "RMS",

  "flash.title": "Firmware flash",
  "flash.probe": "Probe",
  "flash.chip": "Chip",
  "flash.firmware": "Firmware",
  "flash.format": "Format",
  "flash.binBase": "BIN base",
  "flash.binBase.placeholder": "Empty = target default start address",
  "flash.file.placeholder": "Choose .elf / .hex / .bin / .uf2 firmware",
  "flash.browse": "Browse…",
  "flash.verify": "Verify after flash",
  "flash.reset": "Reset after flash",
  "flash.do": "Flash",
  "flash.doRun": "Flash & open RTT",
  "flash.noFile": "Please select a firmware file first",
  "flash.flashing": "Flashing {path} …",
  "flash.connectingRtt": "{msg}, connecting RTT…",
  "flash.error": "Flash failed: {e}",
  "flash.demoDone": "Flash complete (demo): {chip}",
  "flash.filterFirmware": "Firmware",
  "flash.filterAll": "All files",

  // ── Protocol page (Modbus RTU) ──
  "protocol.notConnected": "Not connected (connect a serial/network in the top bar)",
  "protocol.connected": "Connected (uses top-bar connection)",
  "protocol.txBuf": "TX buffer",
  "protocol.rxBuf": "RX buffer",
  "protocol.clear": "Clear data",
  "protocol.slave": "Slave addr",
  "protocol.regAddr": "Register addr",
  "protocol.regCount": "Register count",
  "protocol.read": "Read",
  "protocol.send": "Send",
  "protocol.coilValue": "Coil value",
  "protocol.regValue": "Register value",
  "protocol.regValues": "Register values (space/comma separated)",
  "protocol.arbitrary": "Arbitrary command",
  "protocol.arbitraryPlaceholder": "Enter HEX…",
  "protocol.crcSend": "Send CRC",
  "protocol.f01": "01 Read coils",
  "protocol.f02": "02 Read discrete inputs",
  "protocol.f03": "03 Read holding registers",
  "protocol.f04": "04 Read input registers",
  "protocol.f05": "05 Write single coil",
  "protocol.f06": "06 Write single holding register",
  "protocol.f10": "0x10 Write multiple holding registers",
  "protocol.empty": "—",
  "protocol.invalidInput": "Invalid input",
  "protocol.respErr": "Exception: {code}",
  "protocol.bitsResult": "Bits({n}): {bits}",
  "protocol.regsResult": "Registers({n}): {vals}",
  "protocol.unexpected": "Unexpected response",
  "protocol.timeout": "Response timeout",
  "protocol.sendError": "Send failed: {e}",
  "protocol.writeOk": "Write confirmed: addr={address} value={value}",
  "protocol.writeMultiOk": "Write confirmed: start={address} count={count}",
  "protocol.on": "ON",
  "protocol.off": "OFF",
  "format.auto": "Auto",
  "format.hex": "Intel HEX",

  "settings.appearance": "Appearance",
  "settings.reset": "Reset defaults",
  "settings.reset.title": "Reset all appearance settings to defaults",
  "settings.hint": "Settings apply immediately and are saved in the browser. Click the top-right button to reset.",
  "settings.themeCard": "🎨 Theme",
  "settings.theme": "Color scheme",
  "settings.groupSystem": "System",
  "settings.groupLight": "Light",
  "settings.groupDark": "Dark",
  "settings.groupColor": "Color",
  "settings.themeNote": "When 'Follow system' is chosen, the app switches with the OS light/dark mode.",
  "settings.logCard": "📄 Log area",
  "settings.logSize": "Font size",
  "settings.logFamily": "Font",
  "settings.fontYahei": "Microsoft YaHei (non-mono)",
  "settings.fontSystem": "System default (non-mono)",
  "settings.logNote": "Affects the log view and HEX display font.",
  "settings.termCard": "⌨️ Terminal",
  "settings.termSize": "Terminal size",
  "settings.termNote": "xterm terminal emulator font size.",
  "settings.langCard": "🌐 Language",
  "settings.lang": "Interface language",
  "settings.langNote": "Switching language refreshes the UI (tabs and settings are preserved).",
  "settings.chartCard": "📊 Chart export",
  "settings.chartStyle": "Export style",
  "settings.chartStyleNote": "Controls the style of the right-click copied/exported chart image.",
  "chartstyle.theme": "Follow theme",
  "chartstyle.paper": "Paper (white bg)",
  "lang.zh": "中文",
  "lang.en": "English",

  "theme.system": "Follow system",
  "theme.light": "Light",
  "theme.solarLight": "Solarized Light",
  "theme.dark": "Dark (default)",
  "theme.midnight": "Dark · Midnight",
  "theme.solar": "Dark · Solarized",
  "theme.oled": "Dark · OLED",
  "theme.nord": "Dark · Nord",
  "theme.dracula": "Dark · Dracula",
  "theme.orange": "Orange",
  "theme.red": "Red",
  "theme.green": "Green",
  "theme.pink": "Pink",
  "theme.purple": "Purple",

  "sb.rate": "↓ {rx} KB/s ↑ {tx} KB/s",

  "tab.close": "Close tab (Ctrl+W)",
  "tab.max": "At most {n} tabs",
  "tab.newDefault": "New {n}",
  "tab.rename": "✏️ Rename",
  "tab.rename.hint": "Double-click the tab too",
  "tab.duplicate": "🧬 Duplicate tab",
  "tab.duplicate.hint": "Open a new tab with current config",
  "tab.closeOther": "Close other tabs",
  "tab.closeRight": "Close tabs to the right",
  "tab.closeItem": "✕ Close",

  "ctx.cut": "Cut",
  "ctx.copy": "Copy",
  "ctx.paste": "Paste",
  "ctx.paste.hint": "Read clipboard text and insert at cursor",
  "ctx.selectAll": "Select all",

  "ctx.copyPng": "📋 Copy chart as PNG",
  "ctx.copyPng.hint": "Writes to clipboard; falls back to download",
  "ctx.exportCsv": "📄 Export CSV",
  "ctx.exportCsv.all": "All channel buffer data",
  "ctx.exportCsv.ch": "CH{n} buffer data",

  "term.localEcho": "Local echo",
  "term.clear": "Clear",

  "mock.busy": "An active connection exists (disconnect first)",
  "mock.notConnected": "Not connected",
};

const dicts: Record<Lang, Dict> = { zh, en };

/** 当前语言（默认中文；持久化于 localStorage） */
export function getLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

/** 持久化语言选择（不重载） */
export function persistLang(l: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* ignore */
  }
}

/** 切换语言并整页重载（标签页/设置已持久化，重载即恢复） */
export function setLang(l: Lang): void {
  persistLang(l);
  window.location.reload();
}

/** 翻译：key 查字典，缺失时回退 zh，再缺失返回 key 本身 */
export function t(key: string, params?: Record<string, unknown>): string {
  let s = dicts[getLang()][key] ?? dicts.zh[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** 同步 <html lang>，便于 CSS/无障碍 */
function syncHtmlLang() {
  document.documentElement.lang = getLang() === "en" ? "en" : "zh_CN";
}

/**
 * 把 index.html 里的静态标签翻译到位：
 *  - data-i18n="key"         → 元素文本（options 也适用）
 *  - data-i18n-title="key"   → title 属性
 *  - data-i18n-placeholder   → placeholder 属性
 *  - data-i18n-label="key"   → optgroup 的 label 属性
 * 只改 textContent，因此要求带 data-i18n 的元素只能包含纯文本（不得混有控件）。
 */
export function applyStaticI18n(root: ParentNode = document): void {
  syncHtmlLang();
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder!));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-label]").forEach((el) => {
    el.setAttribute("label", t(el.dataset.i18nLabel!));
  });
}
