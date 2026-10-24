import QtQuick
import Quickshell
import Quickshell.Io
import "CapriNotificationPolicy.js" as Policy

// A notification remains owned by the shell. Only its transient popup is delegated.
Item {
    id: bridge
    property bool doNotDisturb: true
    readonly property int deadlineMs: 600
    readonly property int maxPending: 16
    readonly property string instanceId: "qs-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
    property var jobs: ({})
    property int pendingCount: 0
    property bool destroying: false

    // Injectable transport keeps the fixture independent of the live D-Bus service.
    property var commandForOffer: function(id, summary, body, source) { return Policy.offerCommand(id, summary, body, source); }
    property var cancelOffer: function(id) { Quickshell.execDetached(Policy.cancelCommand(id)); }
    signal fallback(var notificationData)

    function offer(data) {
        if (destroying) return;
        if (doNotDisturb || pendingCount >= maxPending) {
            fallback(data);
            return;
        }
        const id = instanceId + "-" + String(data.uid);
        if (jobs[id]) return;
        const job = offerComponent.createObject(bridge, { offerId: id, notificationData: data });
        if (!job) {
            fallback(data);
            return;
        }
        jobs[id] = job;
        pendingCount++;
        job.begin();
    }

    function forget(job) {
        delete jobs[job.offerId];
        job.destroy();
    }

    onDoNotDisturbChanged: {
        if (!doNotDisturb) return;
        const current = Object.keys(jobs);
        for (let i = 0; i < current.length; i++) {
            const job = jobs[current[i]];
            if (job) job.withdraw(false);
        }
    }

    Component.onDestruction: {
        destroying = true;
        const current = Object.keys(jobs);
        for (let i = 0; i < current.length; i++) cancelOffer(current[i]);
    }

    Component {
        id: offerComponent
        Item {
            id: job
            required property string offerId
            required property var notificationData
            readonly property var source: Policy.notificationSource(notificationData)
            readonly property string presentation: Policy.notificationKind(source, notificationData.summary, notificationData.body)
            property bool settled: false
            property bool accepted: false
            property bool closed: false
            property bool streamFinished: false
            property bool processFinished: false
            property int processCode: -1
            property int processStatus: -1
            property double startedAt: 0
            property string output: ""

            function begin() {
                startedAt = Date.now();
                deadline.start();
                transport.command = bridge.commandForOffer(offerId, notificationData.summary, notificationData.body, source);
                transport.running = true;
            }

            function stopTransport() {
                if (transport.running) transport.signal(9);
            }

            function finish(ok) {
                if (settled) return;
                settled = true;
                bridge.pendingCount--;
                deadline.stop();
                accepted = ok && !closed && !bridge.doNotDisturb && Date.now() - startedAt < bridge.deadlineMs;
                if (accepted) {
                    // Native notification TTL is 8 s. Keep closure/DND cancellation connected throughout it.
                    retention.start();
                } else {
                    stopTransport();
                    bridge.cancelOffer(offerId);
                    if (!closed && !bridge.destroying) bridge.fallback(notificationData);
                    bridge.forget(job);
                }
            }

            function considerReply() {
                if (streamFinished && processFinished) finish(Policy.acceptedReply(output, processCode, processStatus));
            }

            function withdraw(isClosed) {
                closed = closed || isClosed;
                if (!settled) {
                    finish(false);
                } else if (accepted) {
                    accepted = false;
                    bridge.cancelOffer(offerId);
                    bridge.forget(job);
                }
            }

            Timer { id: deadline; interval: bridge.deadlineMs; onTriggered: job.finish(false) }
            Timer { id: retention; interval: 9000; onTriggered: bridge.forget(job) }

            Connections {
                target: job.notificationData.notif || null
                ignoreUnknownSignals: true
                function onClosed() { job.withdraw(true); }
            }

            Process {
                id: transport
                stdout: StdioCollector {
                    onStreamFinished: {
                        job.output = this.text;
                        job.streamFinished = true;
                        job.considerReply();
                    }
                }
                // Do not write notification content or transport errors to the shell log.
                stderr: StdioCollector {}
                onExited: (exitCode, exitStatus) => {
                    job.processCode = exitCode;
                    job.processStatus = exitStatus;
                    job.processFinished = true;
                    job.considerReply();
                }
            }
        }
    }
}
