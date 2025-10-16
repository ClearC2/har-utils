#!/usr/bin/env node
/**
 * @file build-har-generator.js
 * @summary HAR generator (G mode) with per-entity create/update controls.
 * @description Interactively chooses counts, optional CSV for updates, builds payloads from schema/static/regex,
 * validates required keys, and writes a single HAR after confirmation.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const {
    ask,
    askInlinePrefilled,
    CONFIG_PATH,
    loadJsonc,
    saveJsonc,
    canonicalEntityKey,
    listEntitiesCaseInsensitive,
    uniqueDatedFilename,
} = require("./build-har-common");

/** Print message and terminate with non-zero exit code. */
function die(msg) {
    console.error(msg);
    process.exit(1);
}

/** Load and validate config structure; ensure `entities` map exists. */
function ensureConfig() {
    const cfg = loadJsonc(CONFIG_PATH, null);
    if (!cfg || typeof cfg !== "object") die(`Could not load a valid config at: ${path.resolve(CONFIG_PATH)}`);
    if (!cfg.entities || typeof cfg.entities !== "object") die(`Config missing "entities" at: ${path.resolve(CONFIG_PATH)}`);
    return cfg;
}

/** Inline numeric prompt; blank yields the minimum value (default 0). */
async function askNumberInlineNoDefault(prompt, min = 0) {
    const s = await askInlinePrefilled(null, `${prompt}:`, "");
    const trimmed = String(s ?? "").trim();
    if (trimmed === "") return min;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < min) return min;
    return Math.floor(n);
}

/** Choose uppercase singular/plural label for display. */
function pluralUpper(n, singularUpper, pluralUpperWord) {
    return n === 1 ? singularUpper : pluralUpperWord;
}
/** Choose 'entry' vs 'entries' for counts. */
function entryWord(n) {
    return n === 1 ? "entry" : "entries";
}

/** Validate routing essentials and return a compact descriptor for HAR building. */
function requireEntityBits(entityKey, entity) {
    if (!entity || typeof entity !== "object") die(`Missing entity config for "${entityKey}".`);

    const create = entity?.routes?.create;
    const update = entity?.routes?.update;
    if (!create || !create.method || !create.path) die(`Missing routes.create (method/path) for "${entityKey}".`);
    if (!update || !update.method || !update.path) die(`Missing routes.update (method/path) for "${entityKey}".`);

    const idParam0 = update?.params?.[0];
    if (!idParam0 || !idParam0.column)
        die(`Missing update mapping for "${entityKey}". Expected routes.update.params[0].column.`);

    return {
        host: entity?.routes?.host || "",
        createMethod: String(create.method).toUpperCase(),
        createPath: create.path,
        updateMethod: String(update.method).toUpperCase(),
        updatePath: update.path,
        idCol: idParam0.column,
    };
}

let RandExp = null;
try { RandExp = require("randexp"); } catch {  }

/** Generate a value matching a regex using randexp if available; limited fallback otherwise. */
function genFromRegexPattern(pattern, maxLen = 256) {
    try {
        if (RandExp) {
            const re = new RandExp(new RegExp(pattern));
            re.max = Math.min(re.max, Math.max(1, maxLen));
            return { ok: true, value: re.gen() };
        }
        const m = String(pattern).match(/^\^?(\[[^\]]+])\{(\d+)}\$?$/);
        if (m) {
            const cls = m[1]; const n = Math.min(parseInt(m[2], 10) || 1, maxLen);
            const pool = cls
                .replace(/^\[/, "").replace(/]$/, "")
                .replace(/A-Z/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
                .replace(/a-z/g, "abcdefghijklmnopqrstuvwxyz")
                .replace(/0-9/g, "0123456789");
            if (!pool.length) return { ok: false, value: "" };
            let out = "";
            for (let i = 0; i < n; i++) out += pool[Math.floor(Math.random() * pool.length)];
            return { ok: true, value: out };
        }
        return { ok: false, value: "" };
    } catch {
        return { ok: false, value: "" };
    }
}

/** Apply side-specific JSON wrapper when defined; otherwise return body as-is. */
function shapePayload({ side, entity, body }) {
    const wrapKey = entity?.payload?.[side]?.jsonPayloadWrapper;
    if (typeof wrapKey === "string" && wrapKey.trim().length > 0) {
        const wrapped = {};
        wrapped[wrapKey] = body;
        return wrapped;
    }
    return body;
}

function _randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function _pick(arr) { return arr[_randInt(0, arr.length - 1)]; }
function _randLetters(n) { const A = 'abcdefghijklmnopqrstuvwxyz'; let s=''; for (let i=0;i<n;i++) s += A[_randInt(0,25)]; return s; }
function _cap(s) { s = String(s||''); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; }

/** Determine maximum content length from column metadata. */
function _maxLenFromCol(col, fallback=256) {
    const L = Number(col?.maxLength) || Number(col?.length);
    if (Number.isFinite(L) && L > 0) return L;
    return fallback;
}

/** --- HARD CAPS for the changelog table --- */
const MAX_DEC19_6_INT_DIGITS = 13; // 19 - 6
const MAX_DEC19_6_ABS = 9999999999999.999999; // 13 nines + . + 6 nines
function clampDecimal19_6(n) {
    if (n == null || n === "") return n;
    let x = Number(n);
    if (!Number.isFinite(x)) return 0;
    // round to 6 fractional digits
    x = Math.round(x * 1e6) / 1e6;
    if (x >  MAX_DEC19_6_ABS) return MAX_DEC19_6_ABS;
    if (x < -MAX_DEC19_6_ABS) return -MAX_DEC19_6_ABS;
    // also ensure integer digits <= 13 (covers 10^13 - 1)
    const abs = Math.abs(x);
    if (abs >= 1e13) {
        const sign = x < 0 ? -1 : 1;
        return sign * (1e13 - 1e-6); // 9999999999999.999999
    }
    return x;
}

/** SQL integer caps to avoid overflow in generated values. */
function _sqlIntCapForType(t) {
    const T = String(t || '').toUpperCase();
    if (T.includes('TINYINT'))   return 255;
    if (T.includes('SMALLINT'))  return 32767;                // positive cap
    if (T.includes('BIGINT'))    return 9007199254740991;     // Number.MAX_SAFE_INTEGER
    return 2147483647; // INT default
}

function clampIntForSqlType(t, n) {
    if (n == null || n === "") return n;
    let x = Number(n);
    if (!Number.isFinite(x)) x = 0;
    // Use signed ranges; keep above/below zero reasonable
    const T = String(t || '').toUpperCase();
    if (T.includes('TINYINT'))   return Math.max(0, Math.min(255, Math.round(x)));
    if (T.includes('SMALLINT'))  return Math.max(-32768, Math.min(32767, Math.round(x)));
    if (T.includes('INT'))       return Math.max(-2147483648, Math.min(2147483647, Math.round(x)));
    if (T.includes('BIGINT')) {
        const MAX = 9007199254740991; // JS safe
        const MIN = -9007199254740991;
        return Math.max(MIN, Math.min(MAX, Math.trunc(x)));
    }
    return Math.trunc(x);
}

/** Try to coerce and normalize any incoming value for the changelog sinks. */
function coerceAndNormalizeForChangelog(col, val) {
    const t = String(col?.type || '').toUpperCase();
    if (val == null) return val;

    // If it's clearly numeric-like, coerce
    const looksNumeric = (v) => (typeof v === "number") ||
        (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));

    if (/DECIMAL|NUMERIC|MONEY|SMALLMONEY/.test(t)) {
        const n = looksNumeric(val) ? Number(val) : 0;
        return clampDecimal19_6(n);
    }
    if (/(^|[^A-Z])(BIGINT|INT|SMALLINT|TINYINT)([^A-Z]|$)/.test(t)) {
        const n = looksNumeric(val) ? Number(val) : 0;
        return clampIntForSqlType(t, n);
    }
    if (/FLOAT|REAL/.test(t)) {
        let n = looksNumeric(val) ? Number(val) : 0;
        if (!Number.isFinite(n)) n = 0;
        // Keep magnitude sane; FLOAT in SQL Server allows big exponents but don't go wild
        if (Math.abs(n) > 1e308) n = (n < 0 ? -1 : 1) * 1e308;
        return n;
    }
    // non-numeric → unchanged (strings, dates, etc.)
    return val;
}

/** Name-based heuristics for common fields (email, phone, city, etc.). */
function _fallbackByName(col, maxLen) {
    const nm = String(col?.name || '').toLowerCase();

    if (/(^|_)first(name)?$/.test(nm)) {
        const firsts = ["Ava","Mia","Noah","Liam","Emma","Olivia","Ethan","Mason","Ella","Grace","Zoe","Logan","Leo","Nora","Lily","Julia","Sofia","Aria","Mila","James"];
        return _pick(firsts).slice(0, maxLen);
    }
    if (/(^|_)last(name)?$/.test(nm) || /surname/.test(nm)) {
        const lasts = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin"];
        return _pick(lasts).slice(0, maxLen);
    }
    if (/email/.test(nm)) {
        const user = (_randLetters(1) + _randLetters(_randInt(5,10))).slice(0, Math.max(3, maxLen - 12));
        return `${user}@example.com`.slice(0, maxLen);
    }
    if (/phone|tel/.test(nm)) {
        const s = `${_randInt(200,999)}-${_randInt(200,999)}-${String(_randInt(0,9999)).padStart(4,'0')}`;
        return s.slice(0, maxLen);
    }
    if (/zip|postal/.test(nm)) {
        return String(_randInt(10000, 98999)).slice(0, maxLen);
    }
    if (/state/.test(nm)) {
        const states = ["TX","CA","NY","FL","WA","CO","IL","GA","NC","AZ","OH","MI","PA","TN","VA"];
        return _pick(states).slice(0, maxLen);
    }
    if (/city/.test(nm)) {
        const cities = ["Austin","Dallas","Seattle","Denver","Phoenix","Atlanta","Chicago","Nashville","Tampa","Charlotte","Columbus","Orlando","Plano","Boulder","Tempe"];
        return _pick(cities).slice(0, maxLen);
    }
    if (/country/.test(nm)) {
        const countries = ["US","Canada","UK","Germany","France","Mexico","Brazil","Japan","Australia","India"];
        return _pick(countries).slice(0, maxLen);
    }
    if (/lat(itude)?$/.test(nm)) {
        return Number((Math.random() * 180 - 90).toFixed(6));
    }
    if (/lon(gitude)?$/.test(nm)) {
        return Number((Math.random() * 360 - 180).toFixed(6));
    }

    return null;
}

/** Helper: choose a random length between ceil(20% * maxLen) and maxLen (inclusive), with a hard cap (default 25). */
function _randLenPercentOfMax(maxLen, minFrac = 0.2, hardCap = 25) {
    const max = Math.max(1, Number(maxLen) || 1);
    const hi  = Math.min(max, Math.max(1, Number(hardCap) || 1));
    const lo  = Math.max(1, Math.ceil(hi * Math.max(0, Math.min(1, minFrac))));
    return _randInt(lo, hi);
}

/** Type-driven fallbacks for numeric/text/date/boolean columns. */
function _fallbackByType(col, maxLen) {
    const t = String(col?.type || '').toUpperCase();

    // STRING-ish types (regex-based generation handled elsewhere)
    if (t.includes('CHAR') || t.includes('TEXT') || t.includes('XML') || t.includes('UNIQUEIDENTIFIER')) {
        const n = _randLenPercentOfMax(maxLen, 0.2, 25); // 20%..100% of maxLen, hard-capped at 25
        const minSeed = Math.min(3, n);                  // preserve 3..n letter behavior
        return _cap(_randLetters(_randInt(minSeed, n)));
    }

    // INTEGER-ish types
    if (/(^|[^A-Z])(BIGINT|INT|SMALLINT|TINYINT)([^A-Z]|$)/.test(t)) {
        if (t.includes('TINYINT')) return _randInt(0, 1);
        const cap = _sqlIntCapForType(t);
        const capDigits = Math.max(1, Math.floor(Math.log10(cap)) + 1);
        const usedDigits = _randInt(Math.max(1, Math.ceil(capDigits * 0.2)), capDigits); // 20%..100% of capacity
        const low  = Math.pow(10, usedDigits - 1);
        const high = Math.min(cap, Math.pow(10, usedDigits) - 1);
        let n = _randInt(low, Math.max(low, high));
        if (Math.random() < 0.5) n = -n; // randomize sign except TINYINT (handled above) / BIT handled elsewhere
        return clampIntForSqlType(t, n);
    }

    // DECIMAL/NUMERIC/MONEY/SMALLMONEY/REAL/FLOAT
    if (/DECIMAL|NUMERIC|MONEY|SMALLMONEY|FLOAT|REAL/.test(t)) {
        const rawPrec  = Number(col?.precision);
        const rawScale = Number(col?.scale);
        const impliedScale = t.includes('MONEY') ? 4 : 2;

        // Clamp at changelog max: p<=19, s<=6
        const prec  = Math.max(1, Math.min(19, Number.isFinite(rawPrec) ? rawPrec : 8));
        const scale = Math.max(0, Math.min(6,  Number.isFinite(rawScale) ? rawScale : impliedScale));

        const intDigitsAllowed = Math.max(1, Math.min(MAX_DEC19_6_INT_DIGITS, prec - scale));

        // Choose digits used in 20%..100% ranges
        const usedInt  = _randInt(Math.max(1, Math.ceil(intDigitsAllowed * 0.2)), intDigitsAllowed);
        const usedFrac = _randInt(Math.max(0, Math.ceil(scale * 0.2)), scale);

        const intLow  = Math.pow(10, Math.max(1, usedInt) - 1);
        const intHigh = Math.pow(10, Math.max(1, usedInt)) - 1;
        const intPart = String(_randInt(intLow, intHigh));

        if (usedFrac <= 0) {
            let v = Number(intPart);
            if (Math.random() < 0.5) v = -v; // randomize sign
            return clampDecimal19_6(v);
        }

        const fracMax  = Math.pow(10, Math.min(9, usedFrac)) - 1; // keep sampling reasonable
        const fracPart = String(_randInt(0, Math.max(0, fracMax))).padStart(usedFrac, '0');

        let v = Number(`${intPart}.${fracPart}`);
        if (Math.random() < 0.5) v = -v; // randomize sign
        return clampDecimal19_6(v);
    }

    // DATE/TIME types: leave behavior unchanged
    if (/DATE|TIME/.test(t)) {
        const now = new Date();
        const daysBack = _randInt(0, 365);
        const d = new Date(now.getTime() - daysBack*24*3600*1000);
        if (/DATE/.test(t) && !/TIME/.test(t)) return d.toISOString().slice(0,10);
        if (/TIME/.test(t) && !/DATE/.test(t)) return d.toISOString().slice(11,19);
        return d.toISOString().slice(0,19);
    }

    if (/\bBIT\b/.test(t)) return _randInt(0,1);

    // Generic fallback string with 20%..100% length, hard-capped at 25
    return _cap(_randLetters(_randLenPercentOfMax(maxLen, 0.2, 25)));
}

function _titleCase(s) { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; }
/** Convert keys to a display label. */
function simpleEntityName(entityKey) {
    const seg = String(entityKey || "").split("_").pop();
    return _titleCase(seg || entityKey);
}

/** Combine name/type heuristics, clipped to column length. */
function genFallbackForColumn(col) {
    const maxLen = _maxLenFromCol(col, 256);
    const byName = _fallbackByName(col, maxLen);
    if (byName != null) {
        return (typeof byName === 'string') ? byName.slice(0, maxLen) : byName;
    }
    const byType = _fallbackByType(col, maxLen);
    return (typeof byType === 'string') ? byType.slice(0, maxLen) : byType;
}

/** NEW: choose a random subset by percentage (rounded) */
function chooseByPercent(arr, percent) {
    const len = Array.isArray(arr) ? arr.length : 0;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const n = Math.max(0, Math.min(len, Math.round(len * (p / 100))));
    if (n === 0) return [];
    const copy = arr.slice();
    shuffleInPlace(copy);
    return copy.slice(0, n);
}

/**
 * Build request body for create/update honoring CSV overrides, static values, and regex generation,
 * then apply fill% selection over the "change pool".
 *
 * Rules:
 * - CREATE: never send serverGeneratedOnCreate; required + static are always included; immutable/static/required are not in the pool.
 * - UPDATE: immutable are never in the pool (unless they have staticValue, which is included earlier); required are eligible for the pool.
 * - We never send blanks; we omit non-selected fields on UPDATE.
 */
function buildBodyForSide({ side, schema, csvRow, csvHeadersLower, fillPercent, entity }) {
    const body = {};
    const pool = [];

    for (const col of (schema || [])) {
        const field = side === "create" ? col.createApiField : col.updateApiField;
        if (!field) continue;

        const hasStatic = Object.prototype.hasOwnProperty.call(col, "staticValue");
        const isImmutable = !!col.immutable;
        const isRequired = !!col.required;
        const isSrvCreate = !!col.serverGeneratedOnCreate;
        const t = String(col?.type || '').toUpperCase();

        // CSV overrides for UPDATE
        if (side === "update" && csvRow && csvHeadersLower && csvHeadersLower.includes(String(field).toLowerCase())) {
            // try to coerce/normalize when numeric column
            const raw = csvRow[field];
            const normalized = coerceAndNormalizeForChangelog(col, raw);
            body[field] = normalized;
            continue;
        }

        // Never send serverGeneratedOnCreate on CREATE (wins over static)
        if (side === "create" && isSrvCreate) {
            continue;
        }

        // Static always included (normalized if numeric)
        if (hasStatic) {
            const val = col.staticValue;
            body[field] = coerceAndNormalizeForChangelog(col, val);
            continue;
        }

        // Candidate value (regex → fallback), then normalize if numeric
        let valueChosen = undefined;
        if (col.generatePatternRegex) {
            const maxLen = (Number(col.maxLength) || Number(col.length) || 256);
            const r = genFromRegexPattern(col.generatePatternRegex, maxLen);
            if (r.ok) valueChosen = r.value;
        }
        if (valueChosen === undefined) valueChosen = genFallbackForColumn(col);
        valueChosen = coerceAndNormalizeForChangelog(col, valueChosen);

        // CREATE: required are always included; not part of pool
        if (side === "create" && isRequired) {
            body[field] = valueChosen;
            continue;
        }

        // Immutable never in the pool (both sides)
        if (isImmutable) {
            // Nothing else to do; immutable gets skipped unless it was static (already handled)
            continue;
        }

        // Otherwise, eligible for pool
        pool.push({ field, value: valueChosen, type: t });
    }

    // Select by percent
    const selected = chooseByPercent(pool, fillPercent);
    for (const s of selected) body[s.field] = s.value;

    return body;
}

function joinUrl(host, p) {
    const h = String(host || "").replace(/\/+$/, "");
    const s = String(p || "").replace(/^\/+/, "");
    return `${h}/${s}`;
}
function buildHarEntry({ method, url, body }) {
    return {
        startedDateTime: new Date().toISOString(),
        time: 0,
        request: {
            method, url, httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [{ name: "content-type", value: "application/json" }],
            queryString: [],
            postData: { mimeType: "application/json", text: JSON.stringify(body) },
        },
        response: {
            status: 0, statusText: "", httpVersion: "HTTP/1.1",
            cookies: [], headers: [],
            content: { size: 0, mimeType: "application/json" },
            redirectURL: "", headersSize: -1, bodySize: -1,
        },
        cache: {}, timings: { send: 0, wait: 0, receive: 0 },
    };
}

function shuffleInPlace(arr, rng = Math.random) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function sqlLiteral(v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "1" : "0";
    return `'${String(v).replace(/'/g, "''")}'`;
}
function buildTopIdsSql(entityKey, entity, numRows) {
    const idParam0 = entity?.routes?.update?.params?.[0];
    if (!idParam0 || !idParam0.column) die(`Entity "${entityKey}" missing routes.update.params[0].column.`);
    const idCol = idParam0.column;

    const where = [];
    for (const col of (entity.schema || [])) {
        if (Object.prototype.hasOwnProperty.call(col, "staticValue")) {
            if (!col.name) die(`Entity "${entityKey}" has a staticValue without a column "name" in schema.`);
            where.push(`${col.name} = ${sqlLiteral(col.staticValue)}`);
        }
    }
    where.push(`${idCol} IS NOT NULL`);

    const n = Math.max(1, Number(numRows) || 1);
    return [
        `SELECT TOP (${n}) ${idCol}`,
        `FROM ${entityKey}`,
        `WHERE ${where.join(" AND ")}`,
        `ORDER BY NEWID();`,
    ].join("\n");
}

/* ----------------------- Update-source & key selection ----------------------- */
function createExistingKeyPicker(updateSource) {
    if (!updateSource || !updateSource.csvPath || !Array.isArray(updateSource.fields) || !updateSource.fields.length) {
        throw new Error('Invalid updateSource: expected { csvPath, fields[], reusePolicy }');
    }
    // Keep user's relative path; fs resolves it from cwd.
    const raw = fs.readFileSync(updateSource.csvPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error(`No data rows in file: ${updateSource.csvPath}`);
    const delim = lines[0].includes("\t") ? "\t" : ",";
    const headers = lines[0].split(delim).map(h => h.trim());
    const idxByName = Object.fromEntries(headers.map((h, i) => [h, i]));

    for (const f of updateSource.fields) {
        if (!(f in idxByName)) throw new Error(`Key column "${f}" not found in file headers: [${headers.join(", ")}]`);
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(delim);
        const obj = {};
        for (const f of updateSource.fields) obj[f] = (parts[idxByName[f]] ?? "").trim();
        if (updateSource.fields.some(f => obj[f])) rows.push(obj);
    }
    if (!rows.length) throw new Error("All selected key rows are blank after parsing.");

    const policy = updateSource.reusePolicy || "random-with-reuse";
    let ptr = 0;
    let pool = rows.slice();

    if (policy === "random-no-reuse") {
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
    }

    return function pickNextKey() {
        switch (policy) {
            case "sequential-no-reuse":
                if (ptr >= pool.length) throw new Error("Key pool exhausted (sequential-no-reuse).");
                return pool[ptr++];
            case "sequential-with-reuse": {
                const v = pool[ptr % pool.length]; ptr++; return v;
            }
            case "random-no-reuse":
                if (!pool.length) throw new Error("Key pool exhausted (random-no-reuse).");
                return pool.pop();
            case "random-with-reuse":
            default:
                return pool[Math.floor(Math.random() * (pool.length))];
        }
    };
}

function applyRouteParam(updatePath, idCol, idVal) {
    let out = String(updatePath || "");
    const tryReplace = (pat) => {
        const before = out;
        out = out.replace(pat, String(idVal));
        return out !== before;
    };
    const candidates = [
        new RegExp(`:${idCol}\\b`),
        new RegExp(`\\{${idCol}\\}`),
        new RegExp(`<${idCol}>`),
        /:id\b/i, /\{id}/i, /<id>/i
    ];
    for (const c of candidates) if (tryReplace(c)) return out;
    return out.replace(/\/+$/, "") + "/" + encodeURIComponent(String(idVal));
}

/* --------------------------- UX helpers for UPDATE --------------------------- */
async function configureUpdateSourceUX(entityKey, entity, bits, nUpdate) {
    while (true) {
        const v = (await askInlinePrefilled(
            null,
            `Filename of Existing data for ${entityKey}, or H for Help:`,
            entity?.updateSource?.csvPath || entity?.existingDataPath || ""
        )).trim();

        if (/^(h|help)$/i.test(v)) {
            console.log("\nRun this SQL to select existing data, then export or copy it (with headers) to a .csv file:\n");
            console.log(buildTopIdsSql(entityKey, entity, nUpdate));
            console.log("");
            continue;
        }

        if (!v) { console.log("✖ Please enter a filename, or H for Help."); continue; }
        if (!fs.existsSync(v)) { console.log("✖ File not found. Try again, or H for Help."); continue; }

        // Auto-detect header (prefer configured idCol; else first header)
        const raw = fs.readFileSync(v, "utf8");
        const firstLine = (raw.split(/\r?\n/).find(Boolean) || "");
        const delim = firstLine.includes("\t") ? "\t" : ",";
        const headers = firstLine.split(delim).map(h => String(h || "").trim()).filter(Boolean);
        if (!headers.length) { console.log("✖ Could not detect headers in that file."); continue; }

        const chosenHeader = headers.includes(bits.idCol) ? bits.idCol : headers[0];
        console.log(`Detected column: ${chosenHeader}`);

        // Reuse policy (default 4)
        console.log("\nKey selection method [1-4, default=4]:");
        console.log("  1) sequential-no-reuse   – top to bottom once");
        console.log("  2) sequential-with-reuse – loop file endlessly");
        console.log("  3) random-no-reuse       – random order, no repeats");
        console.log("  4) random-with-reuse     – random order, repeats allowed");
        console.log("");

        const choice = (await askInlinePrefilled(null, "Choose [default=4]:", "4")).trim();
        const reuseMap = {
            "1": "sequential-no-reuse",
            "2": "sequential-with-reuse",
            "3": "random-no-reuse",
            "4": "random-with-reuse",
        };
        // if user hits enter (choice=""), default to "4"
        const reusePolicy = reuseMap[choice || "4"];

        // Persist minimal metadata, keeping user's **relative** path exactly as entered
        const csvPath = v;
        entity.updateSource = { csvPath, fields: [chosenHeader], reusePolicy };
        entity.existingDataPath = csvPath; // legacy alias if anything reads it

        // Save to config immediately so it’s remembered
        const cfgNow = loadJsonc(CONFIG_PATH, null);
        if (cfgNow && cfgNow.entities && cfgNow.entities[entityKey]) {
            cfgNow.entities[entityKey].updateSource = entity.updateSource;
            cfgNow.entities[entityKey].existingDataPath = csvPath;
            saveJsonc(CONFIG_PATH, cfgNow);
        }

        console.log("\nSaved update source:");
        console.log(`  Path: ${csvPath}`);
        console.log(`  Policy: ${reusePolicy}\n`);
        return;
    }
}

/* ====================================================================== */
/*                                   MAIN                                 */
/* ====================================================================== */
(async function main() {
    console.log("=== HAR Generator (G mode) ===\n");

    const cfg = ensureConfig();
    const entityKeys = listEntitiesCaseInsensitive(cfg);
    if (!entityKeys.length) die("No entities in config.");

    const allEntries = [];
    const perEntityTotals = new Map(); // entity -> { creates, updates }

    while (true) {
        console.log("Entities:");
        entityKeys.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));

        // Show queued summary line each time we return to the main menu
        const queuedParts = [];
        let totalCalls = 0;
        for (const [ekey, totals] of perEntityTotals.entries()) {
            const name = simpleEntityName(ekey);
            if (totals.creates > 0) {
                queuedParts.push(`${totals.creates} ${name} ${pluralUpper(totals.creates, "Create", "Creates")}`);
                totalCalls += totals.creates;
            }
            if (totals.updates > 0) {
                queuedParts.push(`${totals.updates} ${name} ${pluralUpper(totals.updates, "Update", "Updates")}`);
                totalCalls += totals.updates;
            }
        }
        if (queuedParts.length) {
            console.log("");
            console.log(`QUEUED: ${totalCalls} total ${entryWord(totalCalls)} (${queuedParts.join(", ")})`);
            console.log("");
        }

        console.log("");

        const sel = (await ask("Entity number or name, G to Generate HAR and exit, Q to quit: ")).trim();
        if (/^(g)$/i.test(sel)) break; // exit loop → write once
        if (/^(q)$/i.test(sel)) return 0;

        let entityKey = null;
        const num = parseInt(sel, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= entityKeys.length) {
            entityKey = entityKeys[num - 1];
        } else {
            const canon = canonicalEntityKey(cfg, sel);
            if (canon) entityKey = canon;
        }

        if (!entityKey) { console.log("✖ Invalid selection. Try again.\n"); continue; }
        console.log(`Selected: ${entityKey}`);

        const entity = cfg.entities[entityKey];
        const bits = requireEntityBits(entityKey, entity);
        const schema = entity.schema || [];

        console.log("");
        // NEW: per-entity fill % (sticky defaults; first-run default 50)
        const priorCreatePct = Number(entity?.fill?.createPercent);
        const priorUpdatePct = Number(entity?.fill?.updatePercent);
        const defCreatePctStr = Number.isFinite(priorCreatePct) ? String(priorCreatePct) : "50";
        const defUpdatePctStr = Number.isFinite(priorUpdatePct) ? String(priorUpdatePct) : "50";

        let createPercent = Number(defCreatePctStr);
        let updatePercent = Number(defUpdatePctStr);

        const nCreate = await askNumberInlineNoDefault(`How many CREATE calls for ${entityKey}?`, 0);
        if (nCreate > 0) {
            const ans = (await askInlinePrefilled(null, `Fill % for optional fields on CREATE (${entityKey}) [0-100]:`, defCreatePctStr)).trim();
            const v = ans === "" ? defCreatePctStr : ans;
            createPercent = Math.max(0, Math.min(100, Number(v) || 0));
        }

        const nUpdate = await askNumberInlineNoDefault(`How many UPDATE calls for ${entityKey}?`, 0);
        if (nUpdate > 0) {
            const ans = (await askInlinePrefilled(null, `Fill % for optional fields on UPDATE (${entityKey}) [0-100]:`, defUpdatePctStr)).trim();
            const v = ans === "" ? defUpdatePctStr : ans;
            updatePercent = Math.max(0, Math.min(100, Number(v) || 0));
        }

        // Persist fill% immediately so they become defaults next time
        entity.fill = entity.fill || {};
        entity.fill.createPercent = createPercent;
        entity.fill.updatePercent = updatePercent;
        const cfgNow = loadJsonc(CONFIG_PATH, null);
        if (cfgNow && cfgNow.entities && cfgNow.entities[entityKey]) {
            cfgNow.entities[entityKey].fill = { createPercent, updatePercent };
            saveJsonc(CONFIG_PATH, cfgNow);
        }

        let pickKey = null;
        if (nUpdate > 0) {
            await configureUpdateSourceUX(entityKey, entity, bits, nUpdate);
            pickKey = createExistingKeyPicker(entity.updateSource);
        }

        // CREATE
        for (let i = 0; i < nCreate; i++) {
            const body = buildBodyForSide({ side: "create", schema, csvRow: null, csvHeadersLower: null, fillPercent: createPercent, entity });
            const shaped = shapePayload({ side: "create", entity, body });
            const url = joinUrl(bits.host, bits.createPath);
            allEntries.push(buildHarEntry({ method: bits.createMethod, url, body: shaped }));
        }

        // UPDATE
        for (let i = 0; i < nUpdate; i++) {
            const keyObj = pickKey ? pickKey() : {};
            const idVal = keyObj[bits.idCol] ?? Object.values(keyObj)[0];
            if (!idVal) die(`No "${bits.idCol}" value present in selected key row.`);

            const csvHeadersLower = Object.keys(keyObj).map(k => k.toLowerCase());
            const body = buildBodyForSide({ side: "update", schema, csvRow: keyObj, csvHeadersLower, fillPercent: updatePercent, entity });
            const shaped = shapePayload({ side: "update", entity, body });

            const updatePathApplied = applyRouteParam(bits.updatePath, bits.idCol, idVal);
            const url = joinUrl(bits.host, updatePathApplied);
            allEntries.push(buildHarEntry({ method: bits.updateMethod, url, body: shaped }));
        }

        const prev = perEntityTotals.get(entityKey) || { creates: 0, updates: 0 };
        prev.creates += nCreate; prev.updates += nUpdate;
        perEntityTotals.set(entityKey, prev);

        console.log(
            `\nQueued ${nCreate} ${pluralUpper(nCreate, "CREATE", "CREATES")} and ` +
            `${nUpdate} ${pluralUpper(nUpdate, "UPDATE", "UPDATES")} for ${entityKey}.\n`
        );
    }

    // If nothing queued, just exit quietly.
    if (!allEntries.length) return;

    // Summary
    console.log("Summary:");
    for (const [ekey, totals] of perEntityTotals.entries()) {
        const total = totals.creates + totals.updates;
        console.log(
            `  ${ekey} — ${total} calls (` +
            `${totals.creates} ${pluralUpper(totals.creates, "CREATE", "CREATES")} / ` +
            `${totals.updates} ${pluralUpper(totals.updates, "UPDATE", "UPDATES")})`
        );
    }
    console.log(`Total queued: ${allEntries.length} ${entryWord(allEntries.length)}\n`);

    // Inline filename prompt with last-used prefill (editable); keep **relative** path as typed
    const cfg2 = loadJsonc(CONFIG_PATH, null) || {};
    const suggested = cfg2.lastUsedHarPath || uniqueDatedFilename("generated", ".har");
    let outPath;
    while (true) {
        const raw = await askInlinePrefilled(null, `Output HAR filename [last: ${suggested}]: `, suggested);
        const p = String(raw || "").trim() || suggested;

        if (fs.existsSync(p)) {
            // Non-prefilled overwrite prompt, default = N (user must explicitly type Y)
            const owRaw = await askInlinePrefilled(null, `File "${p}" exists. Overwrite? (y/N): `, "");
            const ow = String(owRaw || "").trim().toLowerCase();
            const yes = (ow === "y" || ow === "yes");
            if (!yes) {
                // Default (ENTER or anything other than Y) means do not overwrite; reprompt
                continue;
            }
            console.log(`Overwriting "${p}"...`);
        }

        outPath = p;
        break;
    }

    // Write once
    // Randomize final call order within the HAR
    shuffleInPlace(allEntries);

    const har = { log: { version: "1.2", creator: { name: "build-har-generator", version: "G" }, entries: allEntries } };
    fs.writeFileSync(outPath, JSON.stringify(har, null, 2), "utf8");

    // Remember globally for future sessions (keep relative form)
    cfg2.lastUsedHarPath = outPath;
    saveJsonc(CONFIG_PATH, cfg2);

    console.log(`Writing HAR → ${outPath}`);
    console.log(`✔ ${allEntries.length} ${entryWord(allEntries.length)} written`);
})();
