export function canPinLauncherIcon() {
  return Boolean(window.Capacitor?.Plugins?.LauncherIcon?.pin);
}

/** 把美化里的图钉到系统桌面（快捷方式）。应用列表里仍是 APK 默认「念」图标。 */
export async function pinCustomLauncherIcon({ imageUrl = '', label = '念' } = {}) {
  const plugin = window.Capacitor?.Plugins?.LauncherIcon;
  if (!plugin?.pin) return { skipped: true };
  return plugin.pin({ imageUrl, label });
}
