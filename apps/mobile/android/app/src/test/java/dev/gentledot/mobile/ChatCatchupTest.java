package dev.gentledot.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class ChatCatchupTest {
    @Test public void initialActivationDoesNotReplayHistoricalAnswers() {
        ChatCatchup state = new ChatCatchup();
        state.ready("chat-a", true);
        assertFalse(state.history("chat-a", "s0-2:old answer"));
    }
    @Test public void monitoringStartedDuringWorkCanCatchUpAfterNetworkLoss() {
        ChatCatchup state = new ChatCatchup();
        state.ready("chat-a", false);
        assertFalse(state.history("chat-a", ""));
        state.ready("chat-a", true);
        assertTrue(state.history("chat-a", "s0-2:finished offline"));
    }
    @Test public void reconnectNotifiesOnlyNewResponsesOnce() {
        ChatCatchup state = new ChatCatchup();
        state.ready("chat-a", true);
        state.history("chat-a", "s0-2:first answer");
        state.ready("chat-a", true);
        assertFalse(state.history("chat-a", "s0-2:first answer"));
        state.ready("chat-a", true);
        assertTrue(state.history("chat-a", "s0-4:answer during network loss"));
        assertFalse(state.history("chat-a", "s0-4:answer during network loss"));
        state.ready("chat-a", true);
        assertFalse(state.history("chat-a", "s0-4:answer during network loss"));
    }
    @Test public void completionOfSameStoredTurnIsDetected() {
        ChatCatchup state = new ChatCatchup();
        state.ready("chat-a", true);
        state.history("chat-a", "s0-2:intermediate answer");
        state.ready("chat-a", false);
        assertFalse(state.history("chat-a", "s0-2:intermediate answer and more tools"));
        state.state(true);
        assertTrue(state.history("chat-a", "s0-2:intermediate answer and final result"));
    }
    @Test public void liveAnswerAndSnapshotDoNotProduceDuplicateNotifications() {
        ChatCatchup state = new ChatCatchup();
        state.ready("chat-a", true);
        state.history("chat-a", "s0-2:first answer");
        state.ready("chat-a", false);
        state.liveReply();
        state.state(true);
        assertFalse(state.history("chat-a", "s0-4:already notified live"));
        state.ready("chat-a", true);
        assertFalse(state.history("chat-a", "s0-4:already notified live"));
    }
    @Test public void SwitchingChatsIsNotAResponse() {
        ChatCatchup state = new ChatCatchup();
        state.ready("chat-a", true);
        state.history("chat-a", "s0-2:answer a");
        state.ready("chat-a", true);
        assertFalse(state.history("chat-b", "s0-20:older chat b"));
        assertFalse(state.history("chat-a", "s0-2:answer a"));
        state.ready("chat-c", true);
        assertFalse(state.history("chat-c", "s0-50:newly opened old chat c"));
    }
    @Test public void emptyHistoryDoesNotClaimAnAnswer() {
        ChatCatchup state = new ChatCatchup();
        state.ready("chat-a", true);
        state.history("chat-a", "s0-2:answer");
        state.ready("chat-a", true);
        assertFalse(state.history("chat-a", ""));
    }
}
