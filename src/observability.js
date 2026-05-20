'use strict';

const MAX_TRACE = 60;
const MAX_FEEDBACK = 20;

function formatClock(ts) {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => n < 10 ? '0' + n : String(n))
        .join(':');
}

function clampArray(items, max) {
    return Array.isArray(items) ? items.slice(0, max) : [];
}

function createObservabilityState(saved = {}) {
    const state = {
        nextId: typeof saved.nextId === 'number' && saved.nextId > 0 ? saved.nextId : 1,
        trace: clampArray(saved.trace, MAX_TRACE),
        feedback: {
            falsePositive: saved.feedback && typeof saved.feedback.falsePositive === 'number'
                ? saved.feedback.falsePositive
                : 0,
            falseNegative: saved.feedback && typeof saved.feedback.falseNegative === 'number'
                ? saved.feedback.falseNegative
                : 0,
            entries: clampArray(saved.feedback && saved.feedback.entries, MAX_FEEDBACK),
        },
        lastBlocked: saved.lastBlocked || null,
        lastClicked: saved.lastClicked || null,
    };

    function push(event = {}) {
        const ts = Date.now();
        const entry = {
            id: 'trace-' + state.nextId++,
            ts,
            time: formatClock(ts),
            source: event.source || 'app',
            action: event.action || 'info',
            label: event.label || '',
            pattern: event.pattern || '',
            cmd: event.cmd || '',
            reason: event.reason || '',
            tool: event.tool || '',
            dryRun: !!event.dryRun,
        };
        state.trace.unshift(entry);
        if (state.trace.length > MAX_TRACE) state.trace.length = MAX_TRACE;
        if (entry.action === 'blocked') state.lastBlocked = entry;
        if ((entry.action === 'clicked' || entry.action === 'native-accept') && !entry.dryRun) {
            state.lastClicked = entry;
        }
        return entry;
    }

    function recordFeedback(kind, meta = {}) {
        const normalized = kind === 'falseNegative' ? 'falseNegative' : 'falsePositive';
        state.feedback[normalized]++;
        const related = normalized === 'falsePositive'
            ? (meta.related || state.lastClicked)
            : (meta.related || state.lastBlocked || state.lastClicked);

        const entry = push({
            source: 'feedback',
            action: normalized,
            label: meta.label || (related && (related.label || related.pattern)) || '',
            cmd: meta.cmd || (related && related.cmd) || '',
            reason: meta.reason || '',
            tool: meta.tool || (related && related.tool) || '',
        });
        state.feedback.entries.unshift(entry);
        if (state.feedback.entries.length > MAX_FEEDBACK) state.feedback.entries.length = MAX_FEEDBACK;
        return entry;
    }

    function snapshot(extra = {}) {
        return Object.assign({
            trace: state.trace.slice(0, 30),
            lastBlocked: state.lastBlocked,
            lastClicked: state.lastClicked,
            feedback: {
                falsePositive: state.feedback.falsePositive,
                falseNegative: state.feedback.falseNegative,
                recent: state.feedback.entries.slice(0, 8),
            },
        }, extra);
    }

    function exportState() {
        return {
            nextId: state.nextId,
            trace: state.trace.slice(0, MAX_TRACE),
            feedback: {
                falsePositive: state.feedback.falsePositive,
                falseNegative: state.feedback.falseNegative,
                entries: state.feedback.entries.slice(0, MAX_FEEDBACK),
            },
            lastBlocked: state.lastBlocked,
            lastClicked: state.lastClicked,
        };
    }

    return {
        exportState,
        push,
        recordFeedback,
        snapshot,
    };
}

module.exports = {
    createObservabilityState,
};
