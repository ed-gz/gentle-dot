package dev.gentledot.mobile;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public class FileTransferBoundaryTest {
    private static final String ID = "a".repeat(43);
    private static final String ORIGIN = "https://desktop.tailnet.ts.net";
    private static final String PATH = "/api/files/" + ID + "/content";

    @Test public void acceptsOnlyTheAuthenticatedContentEndpoint() {
        assertTrue(FileTransferBoundary.validUrl(ORIGIN + PATH));
        assertTrue(FileTransferBoundary.validUrl(ORIGIN + ":443" + PATH));
        assertFalse(FileTransferBoundary.validUrl(ORIGIN + ":8443" + PATH));
        assertFalse(FileTransferBoundary.validUrl(ORIGIN + PATH.replace("/content", "/meta")));
        assertFalse(FileTransferBoundary.validUrl(ORIGIN + PATH + "/"));
        assertFalse(FileTransferBoundary.validUrl(ORIGIN + "/api/files/short/content"));
        assertFalse(FileTransferBoundary.validUrl(ORIGIN + "/api/files/" + "a".repeat(129) + "/content"));
    }

    @Test public void rejectsOtherOriginsCredentialsAndUrlSecrets() {
        for (String value : new String[] {
            "http://desktop.tailnet.ts.net" + PATH, "https://example.com" + PATH,
            "https://desktop.tailnet.ts.net.attacker.test" + PATH,
            "https://user:pass@desktop.tailnet.ts.net" + PATH,
            ORIGIN + PATH + "?token=secret", ORIGIN + PATH + "#secret", "not a URL", null
        }) assertFalse(String.valueOf(value), FileTransferBoundary.validUrl(value));
    }

    @Test public void rejectsEncodedOrAmbiguousPaths() {
        for (String path : new String[] {
            "/api/files/%61" + ID + "/content", "/api/files/../" + ID + "/content",
            "/api/files/" + ID + "%2f/content", "/api//files/" + ID + "/content",
            "/api/files/" + ID + "/content;other", "/api/files/" + ID + "\\content"
        }) assertFalse(path, FileTransferBoundary.validUrl(ORIGIN + path));
    }

    @Test public void preservesOrdinaryInternationalFileNames() {
        assertTrue(FileTransferBoundary.validName("Informe final 2026.pdf"));
        assertTrue(FileTransferBoundary.validName("Diseño — gráfico 🌹.png"));
        assertTrue(FileTransferBoundary.validName("报告.xlsx"));
    }

    @Test public void rejectsTraversalControlCharactersAndOversizedNames() {
        for (String name : new String[] {
            "", ".", "..", "../report.pdf", "dir/report.pdf", "dir\\report.pdf",
            " report.pdf", "report.pdf ", "report\n.pdf", "report\u0000.pdf",
            "report\u202eexe.pdf", "report?.pdf", "é".repeat(121), "a".repeat(241), null
        }) assertFalse(String.valueOf(name), FileTransferBoundary.validName(name));
    }

    @Test public void validatesMimeWithoutHeaderInjectionOrWildcard() {
        assertTrue(FileTransferBoundary.validMime("application/pdf"));
        assertTrue(FileTransferBoundary.validMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
        assertTrue(FileTransferBoundary.validMime("image/svg+xml"));
        for (String mime : new String[] {"image/*", "text/plain; charset=utf8", "image/png\nX: y", "TEXT/plain", "", null})
            assertFalse(String.valueOf(mime), FileTransferBoundary.validMime(mime));
    }

    @Test public void rejectsInvalidTokenOrActionBeforeAnyTransfer() {
        assertThrows(IllegalArgumentException.class, () -> FileTransferBoundary.validate(ORIGIN + PATH, "invalid", "a.pdf", "application/pdf", "save"));
        assertThrows(IllegalArgumentException.class, () -> FileTransferBoundary.validate(ORIGIN + PATH, ID, "a.pdf", "application/pdf", "open"));
        FileTransferBoundary.validate(ORIGIN + PATH, ID, "a.pdf", "application/pdf", "share");
    }

    @Test public void refusesOversizedOrMalformedContentLength() throws Exception {
        assertEquals(-1, FileTransferBoundary.declaredLength(null));
        assertEquals(FileTransferBoundary.MAX_BYTES, FileTransferBoundary.declaredLength("52428800"));
        assertThrows(FileTransferBoundary.TooLarge.class, () -> FileTransferBoundary.declaredLength("52428801"));
        assertThrows(FileTransferBoundary.TooLarge.class, () -> FileTransferBoundary.declaredLength("9999999999999999999"));
        assertThrows(IOException.class, () -> FileTransferBoundary.declaredLength("-1"));
        assertThrows(IOException.class, () -> FileTransferBoundary.declaredLength("10,10"));
    }

    @Test public void acceptsExactMaximumWithoutBufferingWholeFile() throws Exception {
        long bytes = FileTransferBoundary.copy(sizedInput(FileTransferBoundary.MAX_BYTES), OutputStream.nullOutputStream(), FileTransferBoundary.MAX_BYTES, () -> false);
        assertEquals(FileTransferBoundary.MAX_BYTES, bytes);
    }

    @Test public void limitsChunkedResponsesAndDoesNotWriteTheOverflowByte() {
        final long[] written = {0};
        OutputStream output = new OutputStream() {
            @Override public void write(int value) { written[0]++; }
            @Override public void write(byte[] value, int offset, int count) { written[0] += count; }
        };
        assertThrows(FileTransferBoundary.TooLarge.class, () -> FileTransferBoundary.copy(sizedInput(FileTransferBoundary.MAX_BYTES + 1), output, -1, () -> false));
        assertEquals(FileTransferBoundary.MAX_BYTES, written[0]);
    }

    @Test public void detectsTruncationAndDoesNotClaimSuccessfulSave() {
        assertThrows(IOException.class, () -> FileTransferBoundary.copy(new ByteArrayInputStream(new byte[3]), new ByteArrayOutputStream(), 4, () -> false));
    }

    @Test public void cancellationStopsBeforeWritingTheNextChunk() {
        AtomicBoolean cancelled = new AtomicBoolean();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        InputStream input = new ByteArrayInputStream(new byte[40]) {
            @Override public synchronized int read(byte[] buffer, int offset, int count) {
                cancelled.set(true);
                return super.read(buffer, offset, count);
            }
        };
        assertThrows(FileTransferBoundary.Cancelled.class, () -> FileTransferBoundary.copy(input, output, -1, cancelled::get));
        assertEquals(0, output.size());
    }

    private static InputStream sizedInput(long size) {
        return new InputStream() {
            long remaining = size;
            @Override public int read() { if (remaining == 0) return -1; remaining--; return 0; }
            @Override public int read(byte[] value, int offset, int length) {
                if (remaining == 0) return -1;
                int count = (int) Math.min(remaining, length);
                remaining -= count;
                return count;
            }
        };
    }
}
