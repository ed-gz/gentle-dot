package dev.gentledot.mobile;

import static org.junit.Assert.*;
import org.junit.Test;

public class CompanionPolicyTest {
    @Test public void neverShowsOverLockOrDuplicatesTheApp() {
        assertTrue(CompanionPolicy.visible(true,true,true,false,false));
        assertFalse(CompanionPolicy.visible(true,true,true,true,false));
        assertFalse(CompanionPolicy.visible(true,true,true,false,true));
        assertFalse(CompanionPolicy.visible(true,true,false,false,false));
        assertFalse(CompanionPolicy.visible(true,false,true,false,false));
        assertFalse(CompanionPolicy.visible(false,true,true,false,false));
    }
    @Test public void noAnimationInBatterySaverOrReducedMotion() {
        assertTrue(CompanionPolicy.animate(true,false,false));
        assertFalse(CompanionPolicy.animate(true,true,false));
        assertFalse(CompanionPolicy.animate(true,false,true));
        assertFalse(CompanionPolicy.animate(false,false,false));
    }
    @Test public void screenBoundsKeepTheWholeSpriteReachable() {
        assertEquals(8,CompanionPolicy.bound(-300,400,112,8));
        assertEquals(280,CompanionPolicy.bound(500,400,112,8));
        assertEquals(120,CompanionPolicy.bound(120,400,112,8));
        assertEquals(8,CompanionPolicy.bound(120,80,112,8));
    }
    @Test public void overlayDoesNotBypassNotificationDenialOrDoNotDisturb() {
        assertTrue(CompanionPolicy.offerNotice(true, true));
        assertFalse(CompanionPolicy.offerNotice(false, true));
        assertFalse(CompanionPolicy.offerNotice(true, false));
        assertFalse(CompanionPolicy.offerNotice(false, false));
    }
    @Test public void meaningfulEventsChooseActions() {
        assertEquals("file-away",CompanionPolicy.action("download"));
        assertEquals("file-away",CompanionPolicy.action("capture"));
        assertEquals("greeting",CompanionPolicy.action("permission"));
        assertEquals("working",CompanionPolicy.action("typing"));
    }
}
