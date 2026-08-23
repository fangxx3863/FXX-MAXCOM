// probe-rs 芯片候选的工具函数：把 `list_chips` 返回的家族列表展开为
// 可直接回填给下拉/attach 的候选 chip 名。开关页（烧录 / RTT）共用。

import type { ChipFamilyInfo } from "./types";
import type { DropdownItem } from "./dropdown";

/**
 * 把 probe-rs 家族列表展开为去重、小写、字母排序的候选 chip 名。
 *
 * probe-rs 的 `get_target_by_name` 大小写不敏感（含 `x` 通配匹配包变体），
 * 因此统一小写既可匹配内置默认值（如 "nrf52840"），也不会影响附着。
 */
export function flattenChips(fams: ChipFamilyInfo[]): DropdownItem[] {
  const seen = new Set<string>();
  const out: DropdownItem[] = [];
  for (const f of fams) {
    for (const v of f.variants) {
      const name = v.trim().toLowerCase();
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push({ value: name, label: name });
      }
    }
  }
  out.sort((a, b) => a.value.localeCompare(b.value));
  return out;
}

/** 在候选列表最前加“自动检测”项（value = "auto"）。 */
export function withAuto(items: DropdownItem[]): DropdownItem[] {
  return [{ value: "auto", label: "自动检测" }, ...items];
}
