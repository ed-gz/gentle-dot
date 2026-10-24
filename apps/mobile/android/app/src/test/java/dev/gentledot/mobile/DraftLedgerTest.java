package dev.gentledot.mobile;

import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class DraftLedgerTest {
    private static DraftLedger ledger() {
        Map<String, DraftLedger.Record> records = new HashMap<>();
        return new DraftLedger(new DraftLedger.Storage() {
            public DraftLedger.Record read(String key) { return records.getOrDefault(key, new DraftLedger.Record("", "0")); }
            public void write(String key, DraftLedger.Record value) { records.put(key, value); }
        });
    }
    @Test public void aHiddenMainWebViewCannotResurrectThePartialChatsClearedDraft() throws Exception {
        DraftLedger ledger = ledger();
        String shared = ledger.save("conversation", "Primer borrador", "0").record.revision;
        DraftLedger.Result partial = ledger.save("conversation", "Texto nuevo", shared);
        DraftLedger.Result sent = ledger.save("conversation", "", partial.record.revision);
        assertTrue(sent.applied); assertFalse("0".equals(sent.record.revision));
        DraftLedger.Result stale = ledger.save("conversation", "Primer borrador", shared);
        assertFalse(stale.applied); assertEquals("", stale.record.text); assertEquals(sent.record.revision, stale.record.revision);
    }
    @Test public void sendingBeforeTheFirstAutosaveStillFencesAnotherWebViewsInitialRead() throws Exception {
        DraftLedger ledger = ledger();
        DraftLedger.Result cleared = ledger.save("conversation", "", "0");
        assertTrue(cleared.applied); assertNotEquals("0", cleared.record.revision);
        DraftLedger.Result pendingOldText = ledger.save("conversation", "Texto viejo sin guardar", "0");
        assertFalse(pendingOldText.applied); assertEquals("", pendingOldText.record.text);
    }
    @Test public void identitiesStaySeparateAndUnchangedTextDoesNotGenerateConflicts() throws Exception {
        DraftLedger ledger = ledger();
        DraftLedger.Result first = ledger.save("device-a/conversation", "Privado", "0");
        assertEquals("", ledger.read("device-b/conversation").text);
        DraftLedger.Result same = ledger.save("device-a/conversation", "Privado", first.record.revision);
        assertTrue(same.applied); assertEquals(first.record.revision, same.record.revision);
    }
    @Test public void concurrentWebViewsProduceExactlyOneAcceptedWriter() throws Exception {
        DraftLedger ledger = ledger(); CountDownLatch start = new CountDownLatch(1); AtomicInteger applied = new AtomicInteger();
        Runnable write = () -> { try { start.await(); if (ledger.save("shared", Thread.currentThread().getName(), "0").applied) applied.incrementAndGet(); } catch (Exception error) { throw new AssertionError(error); } };
        Thread first = new Thread(write, "first"), second = new Thread(write, "second"); first.start(); second.start(); start.countDown(); first.join(); second.join();
        assertEquals(1, applied.get()); assertNotEquals("0", ledger.read("shared").revision);
    }
    @Test public void failedPersistenceDoesNotAdvanceTheRevision() throws Exception {
        DraftLedger ledger = new DraftLedger(new DraftLedger.Storage() {
            public DraftLedger.Record read(String key) { return new DraftLedger.Record("Saved", "r1"); }
            public void write(String key, DraftLedger.Record value) throws Exception { throw new Exception("disk unavailable"); }
        });
        try { ledger.save("key", "Unsaved", "r1"); fail(); } catch (Exception expected) { assertEquals("Saved", ledger.read("key").text); assertEquals("r1", ledger.read("key").revision); }
    }
}
