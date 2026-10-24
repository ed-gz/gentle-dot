package dev.gentledot.mobile;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.function.BooleanSupplier;

/** Validation and bounded streaming independent of Android activities. */
final class FileTransferBoundary {
    static final long MAX_BYTES = 50L * 1024 * 1024;

    static void validate(String url, String token, String name, String mime, String action) {
        if (!validUrl(url) || token == null || !token.matches("[A-Za-z0-9_-]{32,1024}")
            || !validName(name) || !validMime(mime) || !("save".equals(action) || "share".equals(action))) {
            throw new IllegalArgumentException("El archivo o su conexión no son válidos.");
        }
    }

    static boolean validUrl(String value) {
        if (value == null) return false;
        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && host != null
                && host.matches("[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)+\\.ts\\.net")
                && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getRawQuery() == null && uri.getRawFragment() == null
                && uri.getRawPath().matches("/api/files/[A-Za-z0-9_-]{32,128}/content");
        } catch (Exception error) { return false; }
    }

    static boolean validName(String name) {
        if (name == null || name.isEmpty() || !name.equals(name.trim()) || name.equals(".") || name.equals("..")
            || name.getBytes(StandardCharsets.UTF_8).length > 240) return false;
        for (int offset = 0; offset < name.length();) {
            int point = name.codePointAt(offset);
            if (Character.isISOControl(point) || Character.getType(point) == Character.FORMAT
                || Character.getType(point) == Character.SURROGATE || "/\\<>:\"|?*".indexOf(point) >= 0) return false;
            offset += Character.charCount(point);
        }
        return true;
    }

    static boolean validMime(String mime) {
        return mime != null && mime.length() <= 160 && mime.equals(mime.toLowerCase(Locale.ROOT))
            && mime.matches("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*");
    }

    static long declaredLength(String header) throws IOException {
        if (header == null) return -1;
        if (!header.matches("[0-9]{1,19}")) throw new IOException("Longitud de archivo no válida.");
        try {
            long size = Long.parseLong(header);
            if (size > MAX_BYTES) throw new TooLarge();
            return size;
        } catch (NumberFormatException error) { throw new TooLarge(); }
    }

    static long copy(InputStream input, OutputStream output, long declared, BooleanSupplier cancelled) throws IOException {
        if (declared > MAX_BYTES) throw new TooLarge();
        if (declared < -1) throw new IOException("Longitud de archivo no válida.");
        byte[] buffer = new byte[32 * 1024];
        long total = 0;
        while (true) {
            if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new Cancelled();
            int count = input.read(buffer);
            if (count == -1) break;
            if (count == 0) continue;
            if (count > MAX_BYTES - total) throw new TooLarge();
            if (cancelled.getAsBoolean()) throw new Cancelled();
            output.write(buffer, 0, count);
            total += count;
        }
        if (cancelled.getAsBoolean()) throw new Cancelled();
        if (declared >= 0 && declared != total) throw new IOException("El archivo llegó incompleto.");
        return total;
    }

    static final class TooLarge extends IOException {
        TooLarge() { super("El archivo supera el límite de 50 MiB."); }
    }
    static final class Cancelled extends IOException {
        Cancelled() { super("Transferencia cancelada."); }
    }
}
