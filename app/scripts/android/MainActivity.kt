package fun.fangxx.maxcom

import android.graphics.Color
import android.os.Bundle
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// MAXCOM 的安卓 Activity。
//
// 状态栏遮挡顶部功能键的修复：
//   Tauri 模板 targetSdk = 36，而 Android 15+（targetSdk≥35）会强制 edge-to-edge，
//   WebView 内容难免延伸到系统状态栏/导航栏下方，导致手机顶部的功能键（标签条/
//   连接工具栏）被遮挡、难以点按。仅靠去掉 enableEdgeToEdge() 在 Android 15+ 无效。
//   这里在 WebView 创建后挂一个 OnApplyWindowInsetsListener，把系统栏/刘海 insets
//   作为内边距，把内容推回安全区。非 edge-to-edge（Android 14 及以下）时 insets 为 0，
//   不会额外加间距，行为与旧版一致。
// 桌面端不受影响（本文件仅作用于安卓原生工程）。
//
// 注意：升级 Tauri 后若 `tauri android init` 重新生成此文件，CI 里
// scripts/android-native-patch.sh 会用本文件覆盖，请保持两者同步。
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // 与前端深色主题保持一致，避免顶部状态栏透明区透出陌生背景色。
    webView.setBackgroundColor(Color.parseColor("#14161A"))
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
  }
}
