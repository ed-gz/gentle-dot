package dev.gentledot.mobile;

/** Source filtering remains testable without the Android notification manager. */
final class NotificationMode {
    static boolean valid(String mode) { return "dot".equals(mode) || "agents".equals(mode) || "all".equals(mode); }
    static boolean allows(String mode, String source) {
        return valid(mode) && ("permission".equals(source)
            || (("dot".equals(source) || "agents".equals(source)) && ("all".equals(mode) || mode.equals(source))));
    }
}
