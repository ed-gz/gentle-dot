package dev.gentledot.mobile;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;

/** Launcher identity is independent of overlay permission and agent persona. */
final class LauncherIcon {
    interface Components {
        int state(String alias);
        void set(String alias, int state, int flags);
    }

    static String selectedAlias(String theme) {
        return "capri".equals(theme) ? ".CapriLauncher" : ".DefaultLauncher";
    }

    static void apply(String theme, Components components) {
        String selected = selectedAlias(theme);
        String previous = ".CapriLauncher".equals(selected) ? ".DefaultLauncher" : ".CapriLauncher";
        // Enable first: even if Android rejects the second change, there is still a launcher.
        set(components, selected, PackageManager.COMPONENT_ENABLED_STATE_ENABLED);
        set(components, previous, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);
    }

    private static void set(Components components, String alias, int state) {
        int current = components.state(alias);
        int manifestDefault = ".DefaultLauncher".equals(alias)
            ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
        if (current == state || (current == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && manifestDefault == state)) return;
        components.set(alias, state, PackageManager.DONT_KILL_APP);
    }

    static void apply(Context context, String theme) {
        PackageManager manager = context.getPackageManager();
        String pkg = context.getPackageName();
        apply(theme, new Components() {
            public int state(String alias) { return manager.getComponentEnabledSetting(new ComponentName(pkg, pkg + alias)); }
            public void set(String alias, int state, int flags) {
                manager.setComponentEnabledSetting(new ComponentName(pkg, pkg + alias), state, flags);
            }
        });
    }
}
