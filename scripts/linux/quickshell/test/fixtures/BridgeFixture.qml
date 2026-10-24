import QtQuick
import Quickshell
import "../.."

ShellRoot {
    id: fixture
    property var fallbacks: []
    property var cancels: []
    property var offered: []
    property var sources: []
    property var nextCheck
    property var notices: []
    property int checks: 0
    property bool finished: false
    property var current

    function assert(value, message) {
        if (!value) {
            console.error("CAPRI_FIXTURE_FAILED: " + message);
            finished = true;
            Qt.quit();
            throw new Error(message);
        }
        checks++;
    }
    function later(ms, fn) { nextCheck = fn; step.interval = ms; step.start(); }
    function data(uid, scenario) {
        const notice = noticeComponent.createObject(fixture);
        notices.push(notice);
        return { uid: uid, summary: scenario, body: "Private text must not reach logs", notif: notice };
    }
    function count(uid) { return fallbacks.filter(value => value === uid).length; }
    function cancelled(uid) { return cancels.some(value => value.endsWith("-" + uid)); }
    function hasJob(uid) { return !!bridge.jobs[bridge.instanceId + "-" + uid]; }

    Component { id: noticeComponent; QtObject { property var hints: ({}); property string desktopEntry: ""; property string appName: ""; property int urgency: 1; signal closed() } }
    Timer { id: step; onTriggered: if (!fixture.finished) fixture.nextCheck() }
    Timer { interval: 10000; running: true; onTriggered: fixture.assert(false, "fixture timed out") }

    CapriNotificationBridge {
        id: bridge
        doNotDisturb: false
        commandForOffer: function(id, summary, body, source) {
            fixture.offered.push(id);
            fixture.sources.push(source);
            return ["node", Qt.resolvedUrl("fake-reply.mjs").toString().replace(/^file:\/\//, ""), summary];
        }
        cancelOffer: function(id) { fixture.cancels.push(id); }
        onFallback: (notificationData) => fixture.fallbacks.push(notificationData.uid)
    }

    function accepted() {
        current = data(1, "true");
        bridge.offer(current);
        bridge.offer(current);
        later(250, function() {
            assert(count(1) === 0 && hasJob(1), "ack suppresses only the normal popup");
            assert(offered.length === 1, "duplicate offer does not create another request");
            current.notif.closed();
            assert(cancelled(1) && !hasJob(1), "closing accepted notification cancels native notification");
            negative();
        });
    }
    function negative() {
        bridge.offer(data(2, "false"));
        bridge.offer(data(3, "error"));
        bridge.offer(data(4, "invalid"));
        later(750, function() {
            for (let uid = 2; uid <= 4; uid++) {
                assert(count(uid) === 1 && cancelled(uid) && !hasJob(uid), "negative reply falls back once: " + uid);
            }
            timeout();
        });
    }
    function timeout() {
        bridge.offer(data(5, "slow"));
        later(750, function() {
            assert(count(5) === 1 && cancelled(5) && !hasJob(5), "deadline cancels offer and restores popup");
            current = data(6, "delayed");
            bridge.offer(current);
            later(50, function() {
                current.notif.closed();
                later(500, function() {
                    assert(count(6) === 0 && cancelled(6), "closing a pending notification prevents fallback");
                    assert(count(5) === 1, "late reply cannot duplicate popup");
                    dndBefore();
                });
            });
        });
    }
    function dndBefore() {
        bridge.doNotDisturb = true;
        const before = offered.length;
        bridge.offer(data(7, "true"));
        assert(count(7) === 1 && offered.length === before, "DND keeps shell handling and makes no offer");
        bridge.doNotDisturb = false;
        bridge.offer(data(8, "delayed"));
        later(50, function() {
            bridge.doNotDisturb = true;
            assert(count(8) === 1 && cancelled(8), "DND during offer cancels and restores shell handling");
            later(450, dndAccepted);
        });
    }
    function dndAccepted() {
        assert(count(8) === 1, "DND cancellation ignores late ack");
        bridge.doNotDisturb = false;
        bridge.offer(data(9, "true"));
        later(250, function() {
            assert(hasJob(9) && count(9) === 0, "next notification accepted after DND ends");
            bridge.doNotDisturb = true;
            assert(cancelled(9) && count(9) === 0, "DND cancels an accepted notification without a duplicate");
            visualFiles();
        });
    }
    function visualFiles() {
        bridge.doNotDisturb = false;
        current = data(30, "Screenshot Saved"); current.appName="Screenshot"; current.body="File: capture.png";
        bridge.offer(current);
        later(250,function() {
            const capture=bridge.jobs[bridge.instanceId+"-30"];
            assert(capture && capture.presentation==="capture", "exact screenshot producer selects visual reaction");
            assert(count(30)===0 && sources[sources.length-1].appName==="Screenshot", "visual ACK suppresses popup and transports source");
            current.notif.closed();assert(cancelled(30), "visual closure cancels exact offer");
            current=data(31,"report.pdf");current.appName="Firefox";current.notif.hints={category:"transfer.complete"};
            bridge.offer(current);
            later(250,function() {
                assert(bridge.jobs[bridge.instanceId+"-31"].presentation==="download" && count(31)===0,"completed transfer gets an acknowledged visual reaction");
                current.notif.closed();
                current=data(32,"Screenshot Saved");current.appName="Slack";bridge.offer(current);
                later(250,function() {
                    assert(bridge.jobs[bridge.instanceId+"-32"].presentation==="notification","Slack text cannot turn into a screenshot action");
                    assert(sources[sources.length-1].sender===undefined,"no author is inferred from body text");
                    current.notif.closed();
                    current=data(33,"false");current.appName="Firefox";current.notif.hints={category:"transfer.complete"};bridge.offer(current);
                    later(750,function(){
                        assert(count(33)===1 && cancelled(33),"unacknowledged visual reaction restores the original popup");
                        assert(!hasJob(33),"failed visual transport is disposed");
                        capacity();
                    });
                });
            });
        });
    }
    function capacity() {
        bridge.doNotDisturb = false;
        const burst = [];
        for (let uid = 10; uid < 30; uid++) { const n = data(uid, "slow"); burst.push(n); bridge.offer(n); }
        assert(bridge.pendingCount === 16, "pending transport count is bounded");
        for (let uid = 26; uid < 30; uid++) assert(count(uid) === 1, "overflow restores popup immediately");
        for (let i = 0; i < 16; i++) burst[i].notif.closed();
        assert(bridge.pendingCount === 0, "closing pending burst releases all slots");
        later(750, function() {
            for (let uid = 10; uid < 26; uid++) assert(count(uid) === 0, "closed burst does not reappear");
            assert(Object.keys(bridge.jobs).length === 0, "completed jobs are disposed");
            finished = true;
            console.log("CAPRI_FIXTURE_PASSED: " + checks);
            Qt.quit();
        });
    }
    Component.onCompleted: accepted()
}
