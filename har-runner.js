#!/usr/bin/env node
/**
 * @file har-runner.js
 * @summary Parallel HAR executor and performance summarizer (R mode).
 * @description Replays XHR‑like entries, measures timing/HTTP stats, prints tables, and logs thrown‑fetch exceptions with context.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const {ensureDirForFile, localTsYmdHms, percentile, refreshCompactJWT, shuffleInPlace, toCsvField, truncateUrl, tsForFile, makePrompts} = require('./build-har-common');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
// Bind a single, shared prompt API from common so there is exactly one ask().
const { ask, askPrefill, askNumberPrefill, askYesNoPrefill } = makePrompts(rl);
;

/** Resolve run config path from CLI flag or default to 'run-har.config.json'. */
const DEFAULT_CONFIG_PATH = (() => {
    const arg = process.argv.find(a => a.startsWith('--config='));
    return arg ? arg.split('=')[1] : 'run-har.config.json';
})();
/** Load saved defaults; return object with __path marker for later persistence. */
function loadConfig(fp = DEFAULT_CONFIG_PATH) {
    try {
        const txt = fs.readFileSync(fp, 'utf8');
        const obj = JSON.parse(txt);
        console.log(`[ok] Loaded defaults from ${fp}`);
        return { __path: fp, ...obj };
    } catch { return { __path: fp }; }
}
/** Save defaults back to disk excluding the transient __path field. */
function saveConfig(fp, cfgObj) {
    const toSave = { ...cfgObj };
    delete toSave.__path;
    fs.writeFileSync(fp, JSON.stringify(toSave, null, 2), 'utf8');
    console.log(`[ok] Saved defaults to ${fp}`);
}

/** Prompt with visible default and inline prefilled value pulled from config. */
/** Current timestamp as ISO UTC string. */
/** Compact timestamp for filenames (no colons, timezone Z). */

/** Empirical percentile selection without interpolation. */

/** Escape a string and wrap in quotes for CSV. */

// ---------- base64url / JWT helpers ----------
/** Base64url encode a UTF‑8 string using URL-safe alphabet and no padding. */

/** Refresh an HS256 JWT (update exp and re-sign); pass-through for non-HS256 tokens. */

// ---------- HAR parsing & heuristics ----------
/** Extract HAR entries from log.entries or top-level entries array. */
function parseHarEntries(harObj) {
    if (harObj && harObj.log && Array.isArray(harObj.log.entries)) return harObj.log.entries;
    if (Array.isArray(harObj.entries)) return harObj.entries;
    return [];
}
/** Detect XHR-like requests via DevTools tag and header/initiator patterns. */
function isXhrHeuristic(entry) {
    if (!entry || !entry.request) return false;
    if (entry._resourceType && String(entry._resourceType).toLowerCase() === 'xhr') return true;
    const headers = (entry.request.headers || []).reduce((acc, h) => {
        if (!h || !h.name) return acc;
        acc[String(h.name).toLowerCase()] = String(h.value ?? '');
        return acc;
    }, {});
    const sfm = headers['sec-fetch-mode'];
    const sfd = headers['sec-fetch-dest'];
    const xrw = headers['x-requested-with'];
    const accept = headers['accept'] || '';
    const ct = headers['content-type'] || '';
    if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
    if (sfm && sfm.toLowerCase() === 'cors') return true;
    if (sfd && (sfd.toLowerCase() === 'empty' || sfd.toLowerCase() === 'fetch')) return true;
    if (/application\/json/i.test(accept) || /application\/json/i.test(ct)) return true;
    return !!(entry._initiator && entry._initiator.type === 'script');

}

/** Shuffle entries by fixed-size chunks to distribute load across threads. */
function prepareQueue(entries) {
    const out = [];
    for (let i = 0; i < entries.length; i += 10) {
        const chunk = entries.slice(i, i + 10);
        shuffleInPlace(chunk);
        out.push(...chunk);
    }
    return out;
}

/** === Global Stats CSV (header-or-append) === */

const GLOBAL_CSV_COLUMNS = [
    'timestamp','run_title','avg_ms','min_ms','max_ms','p50_ms','p90_ms','p99_ms',
    'total_hars','inputs','threads_per_file','max_minutes','max_calls_per_thread',
    'total_threads_spawned','executed_requests',
    'exceptions_total','c2xx','c3xx','c4xx','c5xx','error_status'
];
/**
 * appendGlobalStatsCsvRow — HAR execution/metrics helper; refer to the name for the specific role.
 *
 * @param {any} csvPath - input parameter.
 * @param {any} columns - input parameter.
 * @param {any} values - input parameter.
 * @returns {any} Result.
 */
function appendGlobalStatsCsvRow(csvPath, columns, values) {
    try {
        ensureDirForFile(csvPath);
        const needsHeader = !fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0;
        if (needsHeader) fs.appendFileSync(csvPath, columns.map(toCsvField).join(',') + '\n', 'utf8');
        fs.appendFileSync(csvPath, values.map(toCsvField).join(',') + '\n', 'utf8');
    } catch (e) {
        console.error('Failed to write global stats CSV:', e && e.message ? e.message : e);
    }
}
/** Build a row exactly matching the sample CSV header. */
function buildGlobalCsvRow(opts) {
    const {
        timestamp, runTitle, avgMs, minMs, maxMs, p50, p90, p99,
        totalHars, inputs, threadsPerFile, maxMinutes, maxCallsPerThread,
        totalThreadsSpawned, executedRequests,
         exceptionsTotal, c2xx, c3xx, c4xx, c5xx, err
    } = opts;
    return [
        timestamp, runTitle, Number.isFinite(avgMs) ? avgMs.toFixed(2) : 0,
        minMs, maxMs, p50, p90, p99, totalHars, inputs, threadsPerFile, maxMinutes, maxCallsPerThread,
        totalThreadsSpawned, executedRequests,
         exceptionsTotal, c2xx, c3xx, c4xx, c5xx, err
    ];
}

/**
 * resolveCsvPath — HAR execution/metrics helper; refer to the name for the specific role.
 *
 * @param {any} initialPath - input parameter.
 * @param {any} cfgPrefill - input parameter.
 * @returns {any} Result.
 */
async function resolveCsvPath(initialPath, cfgPrefill) {
    let p = initialPath;

    while (true) {
        // If it doesn't exist, we're done.
        if (!fs.existsSync(p)) return { path: p, mode: 'new' };

        console.log(`\n"${p}" already exists.`);
        const rawInput = (await ask(`Choose action for ${p}: [A]ppend / [O]verwrite / new filename (default: A): `)).trim();

        // Default or explicit Append
        if (!rawInput || /^a(ppend)?$/i.test(rawInput)) {
            console.log('→ Appending to existing file.');
            return { path: p, mode: 'append' };
        }

        // Overwrite (truncate so header-or-append logic will write a header)
        if (/^o(verwrite)?$/i.test(rawInput)) {
            try {
                fs.writeFileSync(p, ''); // truncate
                console.log('→ Overwriting existing file.');
                return { path: p, mode: 'overwrite' };
            } catch (e) {
                console.error(`Error overwriting ${p}:`, e.message);
                continue; // ask again
            }
        }

        // Treat anything else as the NEW FILENAME the user just typed
        let candidate = rawInput.replace(/(^["']|["']$)/g, ''); // strip surrounding quotes
        if (!/\.csv$/i.test(candidate)) candidate += '.csv';   // ensure .csv extension
        if (!candidate.trim()) {
            // Fallback: explicit prompt with prefill preserved
            candidate = await askPrefill('Enter a new CSV filename', p, cfgPrefill || p);
        }

        p = candidate.trim();
        // loop continues; existence is checked at the top again
    }
}

/** Open a CSV writer for thrown-fetch exceptions, including request context. */
function openExceptionWriterFor(harPath) {
    const baseNoExt = path.join(path.dirname(harPath), path.parse(harPath).name);
    const fp = path.join(path.dirname(baseNoExt), `${path.basename(baseNoExt)}_exc_${tsForFile()}.csv`);
    ensureDirForFile(fp);
    let headerWritten = false;
    return {
        path: fp,
        writeRow: (method, url, responseText, postBody, sentHeaders) => {
            if (!headerWritten) {
                fs.appendFileSync(fp, `"method","url","response","post","headers"\n`);
                headerWritten = true;
            }
            fs.appendFileSync(
                fp,
                `${toCsvField(method)},${toCsvField(url)},${toCsvField(responseText || '')},${toCsvField(postBody || '')},${toCsvField(sentHeaders || '')}\n`
            );
        }
    };
}

// ---------- metrics aggregation (with HTTP method tallies) ----------
/** Initialize accumulators for timing, status/method counts, and per-URL aggregates. */
function newMetrics() {
    return {
        totalTime: 0,
        timings: [],
        statusCounts: {},
        methodCounts: {},
        exceptions: 0,
        perUrlAgg: new Map()
    };
}
/** Record a sample and update histograms and per-URL aggregates. */
function recordTiming(m, url, method, status, timeMs) {
    m.timings.push(timeMs);
    m.totalTime += timeMs;
    const key = (typeof status === 'number') ? String(status) : 'ERROR';
    m.statusCounts[key] = (m.statusCounts[key] || 0) + 1;
    const meth = (method || 'GET').toUpperCase();
    m.methodCounts[meth] = (m.methodCounts[meth] || 0) + 1;

    let g = m.perUrlAgg.get(url);
    if (!g) { g = { url, count: 0, totalTime: 0, maxTime: 0 }; m.perUrlAgg.set(url, g); }
    g.count += 1; g.totalTime += timeMs; if (timeMs > g.maxTime) g.maxTime = timeMs;
}
/** Summarize timings, status classes, and exception counts; compute p50/p90/p99. */
function summarizeMetrics(m) {
    const t = m.timings;
    const totalRequests = t.length;
    const avgMs = totalRequests ? m.totalTime / totalRequests : 0;
    const minMs = totalRequests ? Math.min(...t) : 0;
    const maxMs = totalRequests ? Math.max(...t) : 0;
    return {
        totalRequests, avgMs, minMs, maxMs,
        p50: percentile(t, 50), p90: percentile(t, 90), p99: percentile(t, 99),
        statusCounts: m.statusCounts,
        methodCounts: m.methodCounts,
        exceptions: m.exceptions
    };
}
/** Merge count maps by summing values with matching keys. */
function mergeCounts(a, b) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + v;
    return out;
}
/** Merge per-URL aggregates across files while preserving max latency. */
function mergePerUrl(dstMap, srcMap) {
    for (const [url, g] of srcMap.entries()) {
        const tgt = dstMap.get(url);
        if (!tgt) dstMap.set(url, { ...g });
        else { tgt.count += g.count; tgt.totalTime += g.totalTime; if (g.maxTime > tgt.maxTime) tgt.maxTime = g.maxTime; }
    }
}
/** Compute 2xx/3xx/4xx/5xx/error totals from a status histogram. */
function classTotals(statusCounts) {
    let c2=0,c3=0,c4=0,c5=0,err=0;
    for (const [k,v] of Object.entries(statusCounts||{})) {
        const n = parseInt(k,10);
        if (!Number.isFinite(n)) { if (k==='ERROR') err+=v; continue; }
        if (n>=200 && n<300) c2+=v;
        else if (n>=300 && n<400) c3+=v;
        else if (n>=400 && n<500) c4+=v;
        else if (n>=500 && n<600) c5+=v;
    }
    return { c2,c3,c4,c5,err };
}

// ---------- printing ----------
/** Pretty-print a single-file summary including class breakdown and pXX metrics. */
function printSummaryBlock(title, s, extraLines = [], excPathMaybe) {
    if (title) console.log(title);
    extraLines.forEach(l => console.log(l));
    console.log(`Executed requests: ${s.totalRequests}`);
    console.log(`Average time     : ${s.avgMs.toFixed(2)} ms`);
    console.log(`Min time         : ${s.minMs} ms`);
    console.log(`Max time         : ${s.maxMs} ms`);
    console.log(`p50              : ${s.p50} ms`);
    console.log(`p90              : ${s.p90} ms`);
    console.log(`p99              : ${s.p99} ms`);
    console.log(`Status counts    : ${JSON.stringify(s.statusCounts)}`);
    const ct = classTotals(s.statusCounts);
    console.log(`By class         : 2xx=${ct.c2}, 3xx=${ct.c3}, 4xx=${ct.c4}, 5xx=${ct.c5}, ERROR=${ct.err}`);
    console.log(`By method        : ${JSON.stringify(s.methodCounts)}`);
    console.log(`Exceptions total : ${s.exceptions} (fetch throws only)`);
    if (excPathMaybe) console.log(`Exceptions file  : ${excPathMaybe}`);
    console.log('');
}
/**
 * printTopTables — HAR execution/metrics helper; refer to the name for the specific role.
 *
 * @param {any} title - input parameter.
 * @param {any} m - input parameter.
 * @returns {any} Result.
 */
function printTopTables(title, m) {
    console.log(title);
    const vals = Array.from(m.perUrlAgg.values());
    const totalCalls = m.timings.length || 1;

    const slowest = [...vals].sort((a, b) => b.totalTime - a.totalTime).slice(0, 20);
    console.log('Top 20 Slowest Calls by URL');
    console.log('URL'.padEnd(76) + '  Calls  Total(ms)  Avg(ms)  Max(ms)  %Calls');
    slowest.forEach(g => {
        const avg = g.count ? g.totalTime / g.count : 0;
        const pct = ((g.count / totalCalls) * 100).toFixed(2) + '%';
        console.log(`${truncateUrl(g.url).padEnd(76)}  ${String(g.count).padStart(5)}  ${String(g.totalTime).padStart(9)}  ${avg.toFixed(2).padStart(7)}  ${String(g.maxTime).padStart(7)}  ${pct.padStart(6)}`);
    });
    console.log('');

    const dupes = [...vals].filter(g => g.count > 1).sort((a, b) => b.count - a.count).slice(0, 20);
    console.log('Top 20 Duplicate URL Calls');
    console.log('URL'.padEnd(76) + '  Calls  Total(ms)  Avg(ms)  Max(ms)  %Calls');
    dupes.forEach(g => {
        const avg = g.count ? g.totalTime / g.count : 0;
        const pct = ((g.count / totalCalls) * 100).toFixed(2) + '%';
        console.log(`${truncateUrl(g.url).padEnd(76)}  ${String(g.count).padStart(5)}  ${String(g.totalTime).padStart(9)}  ${avg.toFixed(2).padStart(7)}  ${String(g.maxTime).padStart(7)}  ${pct.padStart(6)}`);
    });
    console.log('');
}

// ---------- progress rendering ----------
/** Build a multi-line progress display (optionally per-thread) suitable for live console updates. */
function makeProgressRenderer(harStates, showPerThreadProgress) {
    const linesForHar = (state) => 2 + (showPerThreadProgress ? state.perThread.length : 0);

    let totalLines = 0;
    for (const hs of harStates) totalLines += linesForHar(hs);

    for (const hs of harStates) {
        const planned = hs.plannedTotalCalls || hs.capCalls || hs.capEntries || 0;
        const callsInFile = hs.callsInFile || hs.capEntries || 0;
        const barLen = 20;
        const bar = ' '.repeat(barLen);
        const ct = hs.classTotals || { c2:0, c3:0, c4:0, c5:0 };
        console.log(
            `  Running ${path.basename(hs.path)} (${callsInFile} Calls in File) [${bar}]  0%  ` +
            `calls 0/${planned}  (2xx=${ct.c2} 3xx=${ct.c3} 4xx=${ct.c4} 5xx=${ct.c5} Exceptions: 0)`
        );
        if (showPerThreadProgress) {
            for (let i = 0; i < hs.perThread.length; i++) {
                const tBar = ' '.repeat(barLen);
                console.log(
                    `    T${i + 1}: [${tBar}]  0%  0/${hs.perThreadTargetCalls[i]} calls  ` +
                    `(2xx=0 3xx=0 4xx=0 5xx=0 Exceptions: 0)`
                );
            }
        }
        console.log('');
    }

    /**
 * renderLine — utility helper; see implementation for details.
 *
 * @param {any} str - input parameter.
 * @returns {any} Result.
 */
    function renderLine(str) { process.stdout.write(str + '\n'); }

    /**
 * percentForHar — utility helper; see implementation for details.
 *
 * @param {any} hs - input parameter.
 * @returns {any} Result.
 */
    function percentForHar(hs) {
        if (hs.limiter === 'time') {
            const elapsed = Date.now() - hs.startTime;
            const p = hs.capMs > 0 ? Math.min(1, elapsed / hs.capMs) : 1;
            return Math.floor(p * 100);
        } else {
            const denom = Math.max(1, hs.plannedTotalCalls || hs.capCalls || hs.capEntries);
            return Math.floor(Math.min(1, hs.done / denom) * 100);
        }
    }
    /**
 * percentForThread — utility helper; see implementation for details.
 *
 * @param {any} hs - input parameter.
 * @param {any} i - input parameter.
 * @returns {any} Result.
 */
    function percentForThread(hs, i) {
        const denom = Math.max(1, hs.perThreadTargetCalls[i] || 0);
        const val = Math.min(1, (hs.perThread[i] || 0) / denom);
        return Math.floor(val * 100);
    }

    /**
 * barFor — utility helper; see implementation for details.
 *
 * @param {any} pct - input parameter.
 * @returns {any} Result.
 */
    function barFor(pct) {
        const len = 20;
        const filled = Math.max(0, Math.min(len, Math.floor((pct / 100) * len)));
        return '█'.repeat(filled) + ' '.repeat(len - filled);
    }

    /**
 * draw — utility helper; see implementation for details.
 * @returns {any} Result.
 */
    function draw() {
        readline.moveCursor(process.stdout, 0, -totalLines);
        readline.clearScreenDown(process.stdout);

        for (const hs of harStates) {
            const planned = hs.plannedTotalCalls || hs.capCalls || hs.capEntries;
            const callsInFile = hs.callsInFile || hs.capEntries || 0;
            const pctHar = percentForHar(hs);
            const ct = hs.classTotals || { c2:0, c3:0, c4:0, c5:0 };
            const header =
                `  Running ${path.basename(hs.path)} (${callsInFile} Calls in File) ` +
                `[${barFor(pctHar)}] ${String(pctHar).padStart(3)}%  calls ${hs.done}/${planned}  ` +
                `(2xx=${ct.c2} 3xx=${ct.c3} 4xx=${ct.c4} 5xx=${ct.c5} Exceptions: ${hs.exceptions})`;
            renderLine(header);

            if (showPerThreadProgress) {
                for (let i = 0; i < hs.perThread.length; i++) {
                    const tPct = percentForThread(hs, i);
                    const tCt = (hs.perThreadClassTotals && hs.perThreadClassTotals[i]) || { c2:0,c3:0,c4:0,c5:0 };
                    const tExc = (hs.perThreadExceptions && hs.perThreadExceptions[i]) || 0;
                    renderLine(
                        `    T${i + 1}: [${barFor(tPct)}] ${String(tPct).padStart(3)}%  ${hs.perThread[i]}/${hs.perThreadTargetCalls[i]} calls  ` +
                        `(2xx=${tCt.c2} 3xx=${tCt.c3} 4xx=${tCt.c4} 5xx=${tCt.c5} Exceptions: ${tExc})`
                    );
                }
            }

            renderLine('');
        }
    }

    let timer = null;
    return {
        start() { timer = setInterval(draw, 500); },
        stop() {
            if (timer) { clearInterval(timer); timer = null; }
            draw();
            console.log('');
        }
    };
}

/**
 * selectHarFilesFromCwd — utility helper; see implementation for details.
 *
 * @param {any} maxSelect - input parameter.
 * @returns {any} Result.
 */
async function selectHarFilesFromCwd(maxSelect = 4) {
    const all = fs.readdirSync(process.cwd())
        .filter(f => f.toLowerCase().endsWith('.har'))
        .map(f => ({ name: f, mtime: fs.statSync(f).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    if (all.length === 0) {
        console.error('No .har files found in the current directory.');
        process.exit(1);
    }

    console.log('\nAvailable .har files (newest first):');
    all.forEach((f, i) => {
        const dt = new Date(f.mtime).toISOString().replace('T', ' ').replace('Z', '');
        console.log(`  ${String(i + 1).padStart(2, ' ')}. ${f.name}   (${dt})`);
    });
    console.log('');

    const selected = new Set();
    while (selected.size < maxSelect) {
        const remaining = maxSelect - selected.size;
        const ans = await ask(`Select file # (or multiple: "1,3"; 'q' to finish) [remaining ${remaining}]: `);
        const a = ans.trim().toLowerCase();
        if (!a) continue;
        if (a === 'q') break;

        const nums = a.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => Number.isInteger(n) && n >= 1 && n <= all.length);

        if (!nums.length) {
            console.log('  Enter a valid number (or comma-separated numbers) from the list.');
            continue;
        }

        for (const n of nums) {
            if (selected.size >= maxSelect) break;
            selected.add(all[n - 1].name);
        }

        console.log('  Selected so far:', [...selected].join(', ') || '(none)');
    }

    if (selected.size === 0) {
        console.error('No files selected. Exiting.');
        process.exit(1);
    }

    return [...selected];
}

// ---------- run one HAR with N threads ----------
/**
 * runOneHar — utility helper; see implementation for details.
 *
 * @param {any} harInfo - input parameter.
 * @param {any} threadsPerFile - input parameter.
 * @param {any} maxMinutes - input parameter.
 * @param {any} maxCallsPerThread - input parameter.
 * @param {any} useExternalTokens - input parameter.
 * @param {any} tokenLines - input parameter.
 * @param {any} jwtSecretOrNull - input parameter.
 * @param {any} progressStateRef - input parameter.
 * @returns {any} Result.
 */
async function runOneHar(harInfo, threadsPerFile, maxMinutes, maxCallsPerThread, useExternalTokens, tokenLines, jwtSecretOrNull, progressStateRef) {
    // Prepare entries (shuffled in chunks)
    const entriesPrepared = prepareQueue(harInfo.entries);
    const entryCount = entriesPrepared.length;

    const excWriter = openExceptionWriterFor(harInfo.path);
    const timeCapMs = maxMinutes > 0 ? maxMinutes * 60 * 1000 : 0;

    // Determine planned total calls & limiter for progress
    let limiter;
    let capEntries = entryCount;
    let capCalls; // used when call-planned
    let capMs = Number.isFinite(timeCapMs) ? timeCapMs : 0;

    let plannedTotalCalls;
    const perThreadTargetCalls = Array.from({ length: threadsPerFile }, () =>
        (maxCallsPerThread > 0) ? maxCallsPerThread : entryCount
    );

    if (maxCallsPerThread > 0) {
        limiter = (maxMinutes > 0) ? 'time' : 'calls';
        capCalls = threadsPerFile * maxCallsPerThread;     // progress denominator
        plannedTotalCalls = capCalls;
    } else {
        // 0 = one full pass per thread
        limiter = (maxMinutes > 0) ? 'time' : 'calls';
        capCalls = threadsPerFile * entryCount;            // planned calls = threads × entries
        plannedTotalCalls = capCalls;
    }

    const zeroClass = () => ({ c2:0,c3:0,c4:0,c5:0,err:0 });

    const prog = {
        path: harInfo.path,
        startTime: Date.now(),
        limiter,
        capEntries,
        capCalls,
        capMs,
        maxMinutes,
        plannedTotalCalls,
        callsInFile: entryCount,
        total: plannedTotalCalls || capEntries,
        done: 0,
        exceptions: 0,
        classTotals: zeroClass(),
        perThread: Array.from({ length: threadsPerFile }, () => 0),
        perThreadTargetCalls,
        perThreadExceptions: Array.from({ length: threadsPerFile }, () => 0),
        perThreadClassTotals: Array.from({ length: threadsPerFile }, () => zeroClass())
    };
    if (progressStateRef) Object.assign(progressStateRef, prog);

    /**
 * syncProgressOut — utility helper; see implementation for details.
 * @returns {any} Result.
 */
    function syncProgressOut() {
        if (!progressStateRef) return;
        progressStateRef.done = prog.done;
        progressStateRef.exceptions = prog.exceptions;
        progressStateRef.perThread = [...prog.perThread];
        progressStateRef.perThreadTargetCalls = [...prog.perThreadTargetCalls];
        progressStateRef.perThreadExceptions = [...prog.perThreadExceptions];
        progressStateRef.classTotals = { ...prog.classTotals };
        progressStateRef.perThreadClassTotals = prog.perThreadClassTotals.map(ct => ({ ...ct }));
        progressStateRef.callsInFile = prog.callsInFile;
    }

    /**
 * chooseAuthToken — utility helper; see implementation for details.
 *
 * @param {any} originalHeaders - input parameter.
 * @returns {any} Result.
 */
    function chooseAuthToken(originalHeaders) {
        let token = null;
        if (useExternalTokens && tokenLines.length) {
            token = tokenLines[Math.floor(Math.random() * tokenLines.length)];
        } else {
            const authH = (originalHeaders || []).find(h => h && String(h.name).toLowerCase() === 'authorization');
            if (authH && String(authH.value).trim()) token = String(authH.value).trim();
        }
        if (token && jwtSecretOrNull && token.split('.').length === 3) {
            const r = refreshCompactJWT(token, jwtSecretOrNull);
            if (r.ok) token = r.token;
        }
        return token;
    }

    /**
 * bumpClassTotals — utility helper; see implementation for details.
 *
 * @param {any} ct - input parameter.
 * @param {any} statusOrErr - input parameter.
 * @returns {any} Result.
 */
    function bumpClassTotals(ct, statusOrErr) {
        if (statusOrErr === 'ERROR') { ct.err += 1; return; }
        const s = Number(statusOrErr);
        if (s >= 200 && s < 300) ct.c2 += 1;
        else if (s >= 300 && s < 400) ct.c3 += 1;
        else if (s >= 400 && s < 500) ct.c4 += 1;
        else if (s >= 500 && s < 600) ct.c5 += 1;
    }

    const totals = newMetrics();
    const perThreadSummaries = [];
    const startAll = Date.now();

    /**
 * doOneCall — utility helper; see implementation for details.
 *
 * @param {any} entry - input parameter.
 * @param {any} m - input parameter.
 * @param {any} tid - input parameter.
 * @returns {any} Result.
 */
    async function doOneCall(entry, m, tid) {
        const req = entry.request || {};
        const url = req.url;
        const method = (req.method || 'GET').toUpperCase();

        const headersLower = {};
        (req.headers || []).forEach(h => {
            if (h && h.name) headersLower[String(h.name).toLowerCase()] = String(h.value ?? '');
        });

        const outHeaders = {};
        if (headersLower['content-type']) outHeaders['content-type'] = headersLower['content-type'];
        const token = chooseAuthToken(req.headers || []);
        if (token) outHeaders['authorization'] = token;

        let body;
        if (req.postData && typeof req.postData.text === 'string') body = req.postData.text;

        const started = Date.now();
        try {
            const res = await fetch(url, { method, headers: outHeaders, body });
            const dt = Date.now() - started;

            if (!(res.status >= 200 && res.status < 300)) {
                let txt = '';
                try { txt = await res.text(); } catch {}
                excWriter.writeRow(method, url, txt || '', body || '', JSON.stringify(outHeaders));
            }

            recordTiming(m, url, method, res.status, dt);
            bumpClassTotals(prog.classTotals, res.status);
            bumpClassTotals(prog.perThreadClassTotals[tid], res.status);

        } catch (err) {
            const dt = Date.now() - started;

            // Network/Thrown error
            excWriter.writeRow(method, url, String((err && err.message) || 'FETCH_ERROR'), body || '', JSON.stringify(outHeaders));

            totals.exceptions += 1;
            m.exceptions += 1;
            prog.exceptions += 1;
            prog.perThreadExceptions[tid] = (prog.perThreadExceptions[tid] || 0) + 1;

            recordTiming(m, url, method, 'ERROR', dt);
            bumpClassTotals(prog.classTotals, 'ERROR');
            bumpClassTotals(prog.perThreadClassTotals[tid], 'ERROR');
        }
    }

    const workers = Array.from({ length: threadsPerFile }, (_, tid) => {
        return (async () => {
            const m = newMetrics();
            let calls = 0;
            let idx = 0;

            const targetCalls = prog.perThreadTargetCalls[tid];

            while (true) {
                if (timeCapMs && (Date.now() - startAll) >= timeCapMs) break;
                if (targetCalls === 0) break;
                if (calls >= targetCalls) break;

                const entry = entriesPrepared[idx % entryCount];
                await doOneCall(entry, m, tid);

                calls += 1;
                idx += 1;

                prog.perThread[tid] += 1;
                prog.done += 1;
                syncProgressOut();
            }

            perThreadSummaries[tid] = summarizeMetrics(m);
            return m;
        })();
    });

    const results = await Promise.all(workers);
    const elapsedAll = Date.now() - startAll;

    // Merge metrics
    for (const m of results) {
        totals.totalTime += m.totalTime;
        totals.timings.push(...m.timings);
        totals.statusCounts = mergeCounts(totals.statusCounts, m.statusCounts);
        totals.methodCounts = mergeCounts(totals.methodCounts, m.methodCounts);
        totals.exceptions += m.exceptions;
        mergePerUrl(totals.perUrlAgg, m.perUrlAgg);
    }

    const harSummary = summarizeMetrics(totals);
    return {
        harSummary,
        exceptionsPath: excWriter.path,
        perThreadSummaries,
        totals,
        elapsedAll,
        totalEntries: entryCount,
        limiter,
        capEntries: entryCount,
        capCalls,
        capMs,
        maxMinutes
    };
}

/**
 * printIntro — utility helper; see implementation for details.
 *
 * @param {any} detected - input parameter.
 * @returns {any} Result.
 */
function printIntro(detected) {
    /**
 * line — utility helper; see implementation for details.
 *
 * @param {any} name - input parameter.
 * @param {any} required - input parameter.
 * @param {any} present - input parameter.
 * @param {any} note - input parameter.
 * @returns {any} Result.
 */
    const line = (name, required, present, note = '') => {
        const symbol = present ? '✓' : (required ? '✗' : '•');
        const req = required ? 'required' : 'optional';
        return `  ${symbol} ${name.padEnd(18)} (${req}) ${note}`;
    };

    console.log('\n────────────────────────────────────────────────────────────────────────');
    console.log('HAR Runner — Parallel HAR player & performance summarizer');
    console.log('────────────────────────────────────────────────────────────────────────');
    console.log('Required and optional input files (in current directory):');
    console.log(line('*.har', true, true, '— choose one or more HAR files to run.'));
    console.log(line('authTokens.txt', false, detected.authTokens,
        '— Authorization tokens to use for each call. If multiple, one is randomly chosen for each call.'));
    console.log(line('server_jwt.txt', false, detected.jwt,
        '— HS256 secret used to auto refresh JWT expirations (optional).'));
    console.log('────────────────────────────────────────────────────────────────────────\n');
}

// ---------- main ----------
(async function main() {
    const cfg = loadConfig();

    const detected = {
        authTokens: fs.existsSync('authTokens.txt'),
        jwt: fs.existsSync('server_jwt.txt'),
    };
    printIntro(detected);

    const runTitle = await askPrefill('Enter a Run Title (used to label statistics)', '', cfg.run_title || '');

    const harList = await selectHarFilesFromCwd(4);

    let threadsPerFile = await askNumberPrefill(
        `Threads per file (1–10, default 2; Suggested = ${Math.min(10, Math.max(1, Math.floor((os.cpus()?.length || 4) * 0.75))) } based on cores/CPUs)`,
        2,
        cfg.threads_per_file
    );
    if (threadsPerFile < 1) threadsPerFile = 2;
    if (threadsPerFile > 10) threadsPerFile = 10;

    let maxMinutes = await askNumberPrefill('Max runtime per thread in minutes (0 = unlimited)', 0, cfg.max_minutes);
    let maxCallsPerThread = await askNumberPrefill('Max API calls per thread (0 = one full pass/thread)', 0, cfg.max_calls_per_thread);

    const trackTopTables = await askYesNoPrefill('Track & report Top 20 Slowest / Duplicates?', false, cfg.track_top_tables);
    const showThreadSubtotals = await askYesNoPrefill('Show per-thread subtotals?', false, cfg.show_thread_subtotals);
    const showPerThreadProgress = await askYesNoPrefill('Show per-thread live progress?', false, cfg.show_per_thread_progress);

    let outputCsv = await askPrefill('Run metrics CSV filename', 'run-har-stats.csv', cfg.output_csv || 'run-har-stats.csv');
    const { path: resolvedCsv /*, mode*/
 } = await resolveCsvPath(outputCsv, cfg.output_csv || outputCsv);
    outputCsv = resolvedCsv;

    const newCfg = {
        run_title: runTitle,
        har_files: harList,
        threads_per_file: threadsPerFile,
        max_minutes: maxMinutes,
        max_calls_per_thread: maxCallsPerThread,
        show_thread_subtotals: showThreadSubtotals ? 'Y' : 'N',
        track_top_tables: trackTopTables ? 'Y' : 'N',
        show_per_thread_progress: showPerThreadProgress ? 'Y' : 'N',
        output_csv: outputCsv
    };
    const oldStr = JSON.stringify(cfg, Object.keys(cfg).sort());
    const newStr = JSON.stringify(newCfg, Object.keys(newCfg).sort());
    if (oldStr !== newStr) {
        if (await askYesNoPrefill('Save these answers as new defaults?', true, 'Y')) {
            saveConfig(cfg.__path, newCfg);
        }
    }

    let JWT_SECRET = null;
    try { JWT_SECRET = fs.readFileSync('server_jwt.txt', 'utf8').trim(); } catch {}

    const harInfos = [];
    let allHarsHavePopulatedAuth = true;

    for (const p of harList) {
        let obj;
        try { obj = JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { console.error(`Failed to parse HAR: ${p}: ${e.message}`); process.exit(1); }

        const entries = parseHarEntries(obj).filter(isXhrHeuristic);
        let hasPopulatedAuth = false;
        for (const e of entries) {
            const hdr = (e.request?.headers || []).find(h => h && String(h.name).toLowerCase() === 'authorization');
            if (hdr && String(hdr.value).trim()) { hasPopulatedAuth = true; break; }
        }
        if (!hasPopulatedAuth) allHarsHavePopulatedAuth = false;
        harInfos.push({ path: p, obj, entries, hasPopulatedAuth });
    }

    let tokenLines = [];
    let useExternalTokens = false;

    if (!allHarsHavePopulatedAuth) {
        if (!fs.existsSync('authTokens.txt')) {
            console.error('ERROR: authTokens.txt is REQUIRED because at least one HAR lacks a populated Authorization header.');
            process.exit(1);
        }
        useExternalTokens = true;
    }

    for (const info of harInfos) {
        if (info.hasPopulatedAuth) {
            console.log(`[warn] ${info.path} contains populated Authorization headers (sensitive).`);
            let ans = (await ask('Use tokens from HAR (unsafe) or override with authTokens.txt? (har/auth) [default: auth]: ') || 'auth').toLowerCase();
            if (ans === 'auth') useExternalTokens = true;
            else if (ans === 'har') { /* keep embedded tokens for that HAR */
 }
            else useExternalTokens = true;
        }
    }

    if (useExternalTokens) {
        try {
            tokenLines = fs.readFileSync('authTokens.txt', 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            if (tokenLines.length === 0) { console.error('ERROR: authTokens.txt is empty.'); process.exit(1); }
            console.log(`[ok] Loaded ${tokenLines.length} token(s) from authTokens.txt (random per request).`);
        } catch (e) {
            if (allHarsHavePopulatedAuth) {
                console.log('[info] authTokens.txt not found; proceeding with embedded HAR tokens.');
            } else { console.error(`ERROR reading authTokens.txt: ${e.message}`); process.exit(1); }
        }
    } else {
        console.log('[ok] Proceeding with embedded HAR Authorization headers (no override).');
    }
    if (JWT_SECRET) console.log('[ok] server_jwt.txt found — HS256 refresh enabled.');

    rl.close();
    console.log('');

    const harStates = harInfos.map(h => {
        const entryCount = prepareQueue(h.entries).length;
        const perThreadTargetCalls = Array.from({ length: threadsPerFile }, () =>
            (maxCallsPerThread > 0) ? maxCallsPerThread : entryCount
        );
        const plannedCalls = perThreadTargetCalls.reduce((a,b)=>a+b,0);
        const limiter = (maxMinutes > 0) ? 'time' : 'calls';
        const zeroClass = () => ({ c2:0, c3:0, c4:0, c5:0, err:0 });
        return {
            path: h.path,
            startTime: Date.now(),
            limiter,
            capEntries: entryCount,
            capCalls: plannedCalls,
            capMs: (maxMinutes > 0 ? maxMinutes * 60 * 1000 : 0),
            maxMinutes,
            plannedTotalCalls: plannedCalls,
            callsInFile: entryCount,
            total: plannedCalls,
            done: 0,
            exceptions: 0,
            classTotals: zeroClass(),
            perThread: Array.from({ length: threadsPerFile }, () => 0),
            perThreadTargetCalls,
            perThreadExceptions: Array.from({ length: threadsPerFile }, () => 0),
            perThreadClassTotals: Array.from({ length: threadsPerFile }, () => zeroClass())
        };
    });

    const renderer = makeProgressRenderer(harStates, showPerThreadProgress);
    renderer.start();

    const runPromises = harInfos.map((hi, idx) =>
        runOneHar(
            hi,
            threadsPerFile,
            maxMinutes,
            maxCallsPerThread,
            useExternalTokens,
            tokenLines,
            JWT_SECRET,
            harStates[idx]
        ).then(r => ({ info: hi, res: r }))
    );

    const all = await Promise.all(runPromises);
    renderer.stop();

    let global = newMetrics();
    for (const { res } of all) {
        global.totalTime += res.totals.totalTime;
        global.timings.push(...res.totals.timings);
        global.statusCounts = mergeCounts(global.statusCounts, res.totals.statusCounts);
        global.methodCounts = mergeCounts(global.methodCounts, res.totals.methodCounts);
        global.exceptions += res.totals.exceptions;
        mergePerUrl(global.perUrlAgg, res.totals.perUrlAgg);
    }
    const globalSum = summarizeMetrics(global);

    for (const { info, res } of all) {
        const header = `\n=== HAR: ${info.path} (threads: ${threadsPerFile}) ===`;

        let callsLine = '';
        if (res.limiter === 'time') {
            callsLine = `Calls completed    : ${res.harSummary.totalRequests} (time-limited: ${res.maxMinutes}m)`;
        } else {
            const planned = res.capCalls || (threadsPerFile * res.capEntries);
            callsLine = `Calls (done/planned) : ${res.harSummary.totalRequests} / ${planned}`;
        }

        const lines = [
            `Runtime (ms)     : ${res.elapsedAll}`,
            `Total entries    : ${res.totalEntries}`,
            callsLine,
            `Exceptions file  : ${res.exceptionsPath}`
        ];
        printSummaryBlock(header, res.harSummary, lines, null);
        if (trackTopTables) printTopTables(`Top Tables for ${info.path}`, res.totals);
    }

    printSummaryBlock('=== Global Total ===', globalSum, [], null);

    // === Write GLOBAL stats CSV row ===
    try {
        const counts = (globalSum && (globalSum.statusCounts || global.statusCounts)) || {};
        const c2 = (counts['2xx'] || counts[200] || 0);
        const c3 = (counts['3xx'] || counts[300] || 0);
        const c4 = (counts['4xx'] || counts[400] || 0);
        const c5 = (counts['5xx'] || counts[500] || 0);
        const err = (counts['ERROR'] || counts['error'] || 0);
        const totalHars = (Array.isArray(harList) ? harList.length : (Array.isArray(cfg.har_files) ? cfg.har_files.length : 0));
        const totalThreads = (threadsPerFile||0) * (totalHars||0);
        const inputs = harInfos.map(h => path.basename(h.path)).join(',');
        const row = buildGlobalCsvRow({
            timestamp: localTsYmdHms(),
            runTitle,
            avgMs: globalSum.avgMs || 0,
            minMs: globalSum.minMs || 0,
            maxMs: globalSum.maxMs || 0,
            p50: globalSum.p50 || 0,
            p90: globalSum.p90 || 0,
            p99: globalSum.p99 || 0,
            totalHars,
            inputs,
            threadsPerFile,
            maxMinutes,
            maxCallsPerThread,
            totalThreadsSpawned: totalThreads,
            executedRequests: globalSum.totalRequests || 0,
            exceptionsTotal: globalSum.exceptions || global.exceptions || 0,
            c2xx: c2, c3xx: c3, c4xx: c4, c5xx: c5, err
        });
        appendGlobalStatsCsvRow(outputCsv, GLOBAL_CSV_COLUMNS, row);
        console.log(`\nStatistics written to: ${outputCsv}`);
    } catch (e) {
        console.error('Global CSV write failed:', e && e.message ? e.message : e);
    }
})();
