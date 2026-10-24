package dev.gentledot.mobile;

import static org.junit.Assert.*;
import org.junit.Test;

public class SessionNoticeLedgerTest {
    @Test public void liveRepliesAreImmediateAndPollingDoesNotDuplicateThem() {
        SessionNoticeLedger ledger = new SessionNoticeLedger();
        assertTrue(ledger.live("reply-1"));
        assertFalse(ledger.snapshot("reply-1"));
        ledger.baselineComplete();
        assertFalse(ledger.snapshot("reply-1"));
        assertTrue(ledger.snapshot("reply-2"));
        assertFalse(ledger.live("reply-2"));
    }
    @Test public void firstActivationDoesNotReplayHistoryButNeverSwallowsNewSocketEvents() {
        SessionNoticeLedger ledger = new SessionNoticeLedger();
        assertFalse(ledger.snapshot("old-reply"));
        assertFalse(ledger.live("old-reply"));
        assertTrue(ledger.live("new-reply"));
        ledger.baselineComplete();
        assertFalse(ledger.snapshot("new-reply"));
    }
    @Test public void reenabledSourcesRebaselineWhileMalformedIdsNeverProduceNotices() {
        SessionNoticeLedger ledger = new SessionNoticeLedger();
        ledger.baselineComplete();
        ledger.resetBaseline();
        assertFalse(ledger.snapshot("muted"));
        assertFalse(ledger.live(""));
        assertFalse(ledger.live(null));
        ledger.baselineComplete();
        assertTrue(ledger.snapshot("unmuted"));
    }
}
