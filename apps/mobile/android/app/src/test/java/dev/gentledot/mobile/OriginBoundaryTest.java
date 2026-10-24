package dev.gentledot.mobile;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;
public class OriginBoundaryTest {
    @Test public void acceptsCanonicalTailscaleHttpsOrigin() {
        assertTrue(AgentMonitorService.validOrigin("https://desktop.tailnet.ts.net"));
    }
    @Test public void refusesPublicSuffixConfusion() {
        assertFalse(AgentMonitorService.validOrigin("https://desktop.tailnet.ts.net.attacker.test"));
        assertFalse(AgentMonitorService.validOrigin("https://example.com"));
    }
    @Test public void refusesCleartextAndCredentials() {
        assertFalse(AgentMonitorService.validOrigin("http://desktop.tailnet.ts.net"));
        assertFalse(AgentMonitorService.validOrigin("https://user:pass@desktop.tailnet.ts.net"));
    }
    @Test public void refusesRedirectLikePathsAndSecretsInUrls() {
        assertFalse(AgentMonitorService.validOrigin("https://desktop.tailnet.ts.net/path"));
        assertFalse(AgentMonitorService.validOrigin("https://desktop.tailnet.ts.net?token=secret"));
        assertFalse(AgentMonitorService.validOrigin("https://desktop.tailnet.ts.net#fragment"));
    }
    @Test public void refusesArbitraryPortsAndMalformedUrls() {
        assertFalse(AgentMonitorService.validOrigin("https://desktop.tailnet.ts.net:8443"));
        assertFalse(AgentMonitorService.validOrigin("not a URL"));
        assertFalse(AgentMonitorService.validOrigin("https://100.64.1.2"));
    }
}
