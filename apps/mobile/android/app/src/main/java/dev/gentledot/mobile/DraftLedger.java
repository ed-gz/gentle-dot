package dev.gentledot.mobile;

import java.util.UUID;

/** One process-wide compare-and-set boundary, shared by the main and partial WebViews. */
final class DraftLedger {
    static final class Record {
        final String text, revision;
        Record(String text, String revision) { this.text = text; this.revision = revision; }
    }
    static final class Result {
        final Record record;
        final boolean applied;
        Result(Record record, boolean applied) { this.record = record; this.applied = applied; }
    }
    interface Storage {
        Record read(String scope) throws Exception;
        void write(String scope, Record value) throws Exception;
    }
    private final Storage storage;
    DraftLedger(Storage storage) { this.storage = storage; }
    synchronized Record read(String scope) throws Exception { return storage.read(scope); }
    synchronized Result save(String scope, String text, String expectedRevision) throws Exception {
        Record previous = storage.read(scope);
        if (!previous.revision.equals(expectedRevision)) return new Result(previous, false);
        if (!text.isEmpty() && previous.text.equals(text)) return new Result(previous, true);
        // Empty text is a revisioned tombstone. Removing it would make old reads valid again.
        Record next = new Record(text, UUID.randomUUID().toString());
        storage.write(scope, next);
        return new Result(next, true);
    }
}
