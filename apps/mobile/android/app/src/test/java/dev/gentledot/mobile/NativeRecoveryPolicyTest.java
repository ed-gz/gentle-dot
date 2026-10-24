package dev.gentledot.mobile;

import static org.junit.Assert.*;
import java.util.Arrays;
import org.junit.Test;

public class NativeRecoveryPolicyTest {
    @Test public void overlayRestoresOnlyOptedInPermittedMissingService() {
        assertTrue(CompanionPolicy.shouldStart(true,true,false));
        assertFalse(CompanionPolicy.shouldStart(false,true,false));
        assertFalse(CompanionPolicy.shouldStart(true,false,false));
        assertFalse(CompanionPolicy.shouldStart(true,true,true));
        assertTrue(CompanionPolicy.retry(true,true));
        assertFalse(CompanionPolicy.retry(false,true));
        assertFalse(CompanionPolicy.retry(true,false));
    }
    @Test public void attentionWinsThenAnyWorkingAgentThenIdle() {
        assertEquals("permission",CompanionPolicy.aggregate(Arrays.asList("working","blocked","idle")));
        assertEquals("permission",CompanionPolicy.aggregate(Arrays.asList("thinking","needs_you")));
        assertEquals("working",CompanionPolicy.aggregate(Arrays.asList("idle","thinking")));
        assertEquals("working",CompanionPolicy.aggregate(Arrays.asList("idle","working","done")));
        assertEquals("idle",CompanionPolicy.aggregate(Arrays.asList("done","unknown")));
        assertTrue(CompanionPolicy.loop("working","working"));
        assertTrue(CompanionPolicy.loop("idle","idle"));
        assertFalse(CompanionPolicy.loop("greeting","working"));
        assertFalse(CompanionPolicy.loop("greeting","idle"));
    }
    @Test public void monitorRestoresOnlySavedAllowedInactiveMonitor() {
        for(boolean saved:new boolean[]{false,true}) for(boolean allowed:new boolean[]{false,true}) for(boolean active:new boolean[]{false,true}) {
            assertEquals(saved&&allowed&&!active,MonitorStartPolicy.shouldStart(saved,allowed,active));
        }
        assertEquals("needs_permission",MonitorStartPolicy.status(true,false,true,true));
        assertEquals("not_paired",MonitorStartPolicy.status(false,true,false,false));
        assertEquals("disconnected",MonitorStartPolicy.status(true,true,false,false));
        assertEquals("disconnected",MonitorStartPolicy.status(true,true,true,false));
        assertEquals("on",MonitorStartPolicy.status(true,true,true,true));
    }
}
