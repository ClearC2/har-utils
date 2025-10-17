/**
 * @file build-har-common.js
 * @summary Shared utilities for prompts, JSONC I/O, JWT/base64 helpers, URL/text formatting, and small generators.
 * @description Used by the config wizard, HAR generator, and HAR runner to keep UX, parsing, and I/O behavior consistent across tools.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

/** Default config path used by tools that need a shared JSONC mapping file. */
const CONFIG_PATH = "build-har.config.json";

/** Create a readline interface bound to stdin/stdout. @returns {import('readline').Interface} */
function rlCreate() {
    return readline.createInterface({ input: process.stdin, output: process.stdout });
}

/** Prompt for input; accepts (rl,msg) or (msg). Trims the result. */
function ask(rlOrMsg, maybeMsg) {
    const isRl = rlOrMsg && typeof rlOrMsg.question === "function";
    const msg = isRl ? maybeMsg : rlOrMsg;
    const { rl, autoClose } = _ensureRl(isRl ? rlOrMsg : null);
    return new Promise((res) =>
        rl.question(msg, (ans) => {
            if (autoClose) rl.close();
            res((ans ?? "").trim());
        })
    );
}

/** Prompt with a visible default; ENTER applies the default when no input is provided. */
function askWithDefault(rlOrLabel, labelOrDflt, maybeDflt) {

    const isRl = rlOrLabel && typeof rlOrLabel.question === "function";
    const label = isRl ? labelOrDflt : rlOrLabel;
    const dflt  = isRl ? maybeDflt   : labelOrDflt;
    const { rl, autoClose } = _ensureRl(isRl ? rlOrLabel : null);
    return new Promise((res) => {
        const suffix = dflt ? ` [${dflt}]` : "";
        rl.question(`${label}${suffix}: `, (ans) => {
            const out = ans && ans.trim() ? ans.trim() : (dflt || "");
            if (autoClose) rl.close();
            res(out);
        });
    });
}

/** Yes/No prompt with default (Y/n or y/N); returns boolean. */
async function askYesNo(rl, label, defaultYes = true) {
    const hint = defaultYes ? "Y/n" : "y/N";
    while (true) {
        const v = (await askWithDefault(rl, `${label} (${hint})`, defaultYes ? "Y" : "N")).toLowerCase();
        if (v === "y" || v === "yes") return true;
        if (v === "n" || v === "no") return false;
        if (!v) return defaultYes;
    }
}

/** Return an existing readline or create a temporary one with auto-close flag. */
function _ensureRl(maybeRl) {
    if (maybeRl && typeof maybeRl.question === "function") {
        return { rl: maybeRl, autoClose: false };
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return { rl, autoClose: true };
}

/** Prompt with the current value prefilled in the input buffer so it can be edited in place. */
function askInlinePrefilled(rl, label, defValue) {
    const { rl: _rl, autoClose } = _ensureRl(rl);
    return new Promise((resolve) => {
        const shown = defValue != null ? String(defValue) : "";
        _rl.question(`${label} `, (answer) => {
            //const out = answer === "" ? shown : answer;
            const out = answer;
            if (autoClose) _rl.close();
            resolve(out);
        });
        if (shown) _rl.write(shown);
    });
}

/** Remove /* *\/ and // comments from a JSONC string so it can be parsed as JSON. */
function stripJsonc(s) {
    return String(s || "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
/** Load a JSONC file, strip comments, parse to object, or return the fallback on failure. */
function loadJsonc(filepath, fallback = {}) {
    try {
        const raw = fs.readFileSync(filepath, "utf8");
        return JSON.parse(stripJsonc(raw));
    } catch {
        return fallback;
    }
}
/** Write JSON with optional header banner; header is placed above the JSON block. */
function saveJsonc(filepath, obj, header) {
    const body = JSON.stringify(obj, null, 2);
    const sep = header ? (header.endsWith("\n") ? "" : "\n") : "";
    fs.writeFileSync(filepath, header ? `${header}${sep}${body}` : body);
}

/** List unique entity keys ignoring case, preserving first-seen casing. */
function listEntitiesCaseInsensitive(cfg) {
    const out = [];
    const seen = new Set();
    for (const k of Object.keys(cfg.entities || {})) {
        const low = k.toLowerCase();
        if (!seen.has(low)) { seen.add(low); out.push(k); }
    }
    return out;
}
/** Return the canonical entity key matching a case-insensitive input, or null if not found. */
function canonicalEntityKey(cfg, input) {
    const low = (input || "").toLowerCase();
    for (const k of Object.keys(cfg.entities || {})) if (k.toLowerCase() === low) return k;
    return null;
}

/** Generate a YYYYMMDD-based filename with numeric suffix when collisions occur. */
function uniqueDatedFilename(base, ext) {
    const d = new Date();
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const root = `${base}-${y}${m}${dd}${ext.startsWith(".") ? ext : `.${ext}`}`;
    if (!fs.existsSync(root)) return root;
    let i = 2;
    while (fs.existsSync(`${base}-${y}${m}${dd}-${i}${ext}`)) i++;
    return `${base}-${y}${m}${dd}-${i}${ext}`;
}

/* ====================== Generic JSON/HAR convenience ====================== */
function truncateUrl(url) { return !url ? '' : (url.length > 75 ? url.slice(0,75) + '...' : url); }

/**
 * decode — decode Buffers to UTF‑8; pass non‑buffers through as strings.
 *
 * @param {any} bufOrStr - input parameter.
 * @returns {any} Result.
 */
function decode(bufOrStr) {
    if (Buffer.isBuffer(bufOrStr)) return bufOrStr.toString();
    return String(bufOrStr || "");
}
/**
 * formToObj — convert iterable [key, value] pairs into a plain object.
 *
 * @param {any} entries - input parameter.
 * @returns {any} Result.
 */
function formToObj(entries) {
    const out = {};
    for (const [k, v] of entries || []) out[k] = v;
    return out;
}
/**
 * tryExtractJson — locate and parse the first JSON object/array embedded in a string; return null on failure.
 *
 * @param {any} s - input parameter.
 * @returns {any} Result.
 */
function tryExtractJson(s) {
    const m = String(s || "").match(/\{[\s\S]*}|\[[\s\S]*]/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

/* ============================ Deep key helpers ============================ */
/**
 * flattenToDotPaths — flatten a nested object into dot‑path keys (e.g., a.b.c) for easy mapping/inspection.
 *
 * @param {any} obj - input parameter.
 * @param {any} prefix - input parameter.
 * @returns {any} Result.
 */
function flattenToDotPaths(obj, prefix = "") {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) {
            Object.assign(out, flattenToDotPaths(v, key));
        } else {
            out[key] = v;
        }
    }
    return out;
}
/**
 * collectKeysDeep — collect all dot‑path keys from a nested object into a flat list.
 *
 * @param {any} obj - input parameter.
 * @returns {any} Result.
 */
function collectKeysDeep(obj) { return Object.keys(flattenToDotPaths(obj || {})); }

/**
 * askPrefill — prompt in the CLI, showing defaults/prefill where applicable, and normalize the user's response.
 *
 * @param {any} label - input parameter.
 * @param {any} programmedDefault - input parameter.
 * @param {any} configValue - input parameter.
 * @returns {any} Result.
 */
function askPrefill(label, programmedDefault, configValue) {
    const { rl, autoClose } = _ensureRl(null);
    return new Promise(resolve => {
        const prompt = `${label} [${programmedDefault}]: `;
        rl.question(prompt, ans => {
            const val = ans;
            if (autoClose) rl.close();
            if (val === '') return resolve(programmedDefault);
            resolve(val);
        });
        if (configValue !== undefined && configValue !== null && configValue !== '') {
            rl.write(String(configValue));
        }
    });
}

/**
 * askNumberPrefill — prompt in the CLI, showing defaults/prefill where applicable, and normalize the user's response.
 *
 * @param {any} label - input parameter.
 * @param {any} programmedDefault - input parameter.
 * @param {any} configValue - input parameter.
 * @returns {any} Result.
 */
function askNumberPrefill(label, programmedDefault, configValue) {
    // Mirrors the runner's UX: shows [default] hint and pre-fills with config value if present.
    return askPrefill(label, String(programmedDefault), (configValue ?? '') === '' ? '' : String(configValue))
        .then(raw => {
            const n = parseInt(String(raw), 10);
            if (!Number.isFinite(n) || n < 0) return programmedDefault;
            return n;
        });
}

/**
 * askYesNoPrefill — prompt in the CLI, showing defaults/prefill where applicable, and normalize the user's response.
 *
 * @param {any} label - input parameter.
 * @param {any} programmedDefaultBool - input parameter.
 * @param {any} configYN - input parameter.
 * @returns {any} Result.
 */
async function askYesNoPrefill(label, programmedDefaultBool, configYN) {
    // Mirrors the runner's UX: (y/N) with [Y] or [N] shown and optional prefill of 'Y'/'N'.
    const programmedDefChar = programmedDefaultBool ? 'Y' : 'N';
    const prompt = `${label} (y/N) [${programmedDefChar}]: `;
    const { rl, autoClose } = _ensureRl(null);
    return new Promise(resolve => {
        rl.question(prompt, ans => {
            const a = (ans ?? '').trim().toLowerCase();
            if (autoClose) rl.close();
            if (!a) return resolve(programmedDefaultBool);
            if (a === 'y' || a === 'yes') return resolve(true);
            if (a === 'n' || a === 'no') return resolve(false);
            return resolve(programmedDefaultBool);
        });
        if (configYN === 'Y' || configYN === 'N') rl.write(configYN);
    });
}

function localTsYmdHms(d = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return [
        d.getFullYear(),
        pad(d.getMonth() + 1),
        pad(d.getDate())
    ].join('-') + ' ' + [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(':');
}
/**
 * tsForFile — build a filesystem‑safe timestamp string suitable for filenames.
 * @returns {any} Result.
 */
function tsForFile() { return localTsYmdHms().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z'); }

/**
 * toCsvField — escape and quote values when needed for CSV output.
 *
 * @param {any} v - input parameter.
 * @returns {any} Result.
 */
function toCsvField(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * ensureDirForFile — create parent directories for a file path if they do not exist.
 *
 * @param {any} fp - input parameter.
 * @returns {any} Result.
 */
function ensureDirForFile(fp) { fs.mkdirSync(path.dirname(fp), { recursive: true }); }

/**
 * percentile — compute an empirical percentile (no interpolation) from a numeric array.
 *
 * @param {any} values - input parameter.
 * @param {any} p - input parameter.
 * @returns {any} Result.
 */
function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a,b)=>a-b);
    const idx = Math.floor((p / 100) * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * base64urlEncodeUtf8 — utility helper; see implementation for details.
 *
 * @param {any} str - input parameter.
 * @returns {any} Result.
 */
function base64urlEncodeUtf8(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/=/g, '').replace(/\+/g,'-').replace(/\//g,'_');
}

/**
 * base64urlEncodeBuf — utility helper; see implementation for details.
 *
 * @param {any} buf - input parameter.
 * @returns {any} Result.
 */
function base64urlEncodeBuf(buf) {
    return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g,'-').replace(/\//g,'_');
}

/**
 * base64urlDecodeToUtf8 — utility helper; see implementation for details.
 *
 * @param {any} b64u - input parameter.
 * @returns {any} Result.
 */
function base64urlDecodeToUtf8(b64u) {
    const padLen = (4 - (b64u.length % 4)) % 4;
    const b64 = b64u.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat(padLen);
    return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * signHS256 — utility helper; see implementation for details.
 *
 * @param {any} input - input parameter.
 * @param {any} secret - input parameter.
 * @returns {any} Result.
 */
function signHS256(input, secret) {
    return base64urlEncodeBuf(crypto.createHmac('sha256', secret).update(input).digest());
}

/**
 * refreshCompactJWT — utility helper; see implementation for details.
 *
 * @param {any} jwt - input parameter.
 * @param {any} secret - input parameter.
 * @returns {any} Result.
 */
function refreshCompactJWT(jwt, secret) {
    try {
        const parts = jwt.split('.');
        if (parts.length !== 3 || !secret) return { ok: false, token: jwt };
        const header = JSON.parse(base64urlDecodeToUtf8(parts[0]));
        if (String(header.alg).toUpperCase() !== 'HS256') return { ok: false, token: jwt };
        const payload = JSON.parse(base64urlDecodeToUtf8(parts[1]));
        const nowSec = Math.floor(Date.now()/1000);
        const newHeader = { ...header, alg: 'HS256', typ: 'JWT' };
        //const newPayload = { ...payload, iat: nowSec, exp: nowSec + THIRTY_DAYS_S };
        const newPayload = { ...payload, exp: nowSec + (30 * 24 * 60 * 60 ) };
        const h = base64urlEncodeUtf8(JSON.stringify(newHeader));
        const p = base64urlEncodeUtf8(JSON.stringify(newPayload));
        const s = signHS256(`${h}.${p}`, secret);
        return { ok: true, token: `${h}.${p}.${s}`, payload: newPayload };
    } catch { return { ok: false, token: jwt }; }
}

/**
 * joinUrl — utility helper; see implementation for details.
 *
 * @param {any} host - input parameter.
 * @param {any} p - input parameter.
 * @returns {any} Result.
 */
function joinUrl(host, p) {
    const h = String(host || "").replace(/\/+$/, "");
    const s = String(p || "").replace(/^\/+/, "");
    return `${h}/${s}`;
}

/**
 * chooseByPercent — utility helper; see implementation for details.
 *
 * @param {any} arr - input parameter.
 * @param {any} percent - input parameter.
 * @returns {any} Result.
 */
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
 * _sqlIntCapForType — utility helper; see implementation for details.
 *
 * @param {any} t - input parameter.
 * @returns {any} Result.
 */
function _sqlIntCapForType(t) {
    const T = String(t || '').toUpperCase();
    if (T.includes('TINYINT'))   return 255;
    if (T.includes('SMALLINT'))  return 32767;                // positive cap
    if (T.includes('BIGINT'))    return 9007199254740991;     // Number.MAX_SAFE_INTEGER
    return 2147483647; // INT default
}

/**
 * clampIntForSqlType — utility helper; see implementation for details.
 *
 * @param {any} t - input parameter.
 * @param {any} n - input parameter.
 * @returns {any} Result.
 */
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

/**
 * coerceAndNormalizeForChangelog — utility helper; see implementation for details.
 *
 * @param {any} col - input parameter.
 * @param {any} val - input parameter.
 * @returns {any} Result.
 */
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

/**
 * sqlLiteral — utility helper; see implementation for details.
 *
 * @param {any} v - input parameter.
 * @returns {any} Result.
 */
function sqlLiteral(v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "1" : "0";
    return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * _titleCase — utility helper; see implementation for details.
 *
 * @param {any} s - input parameter.
 * @returns {any} Result.
 */
function _titleCase(s) { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; }

/**
 * simpleEntityName — utility helper; see implementation for details.
 *
 * @param {any} entityKey - input parameter.
 * @returns {any} Result.
 */
function simpleEntityName(entityKey) {
    const seg = String(entityKey || "").split("_").pop();
    return _titleCase(seg || entityKey);
}

/**
 * shuffleInPlace — utility helper; see implementation for details.
 *
 * @param {any} arr - input parameter.
 * @param {any} rng - input parameter.
 * @returns {any} Result.
 */
function shuffleInPlace(arr, rng = Math.random) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * askExistingPathPrefill — utility helper; see implementation for details.
 *
 * @param {any} rl - input parameter.
 * @param {any} label - input parameter.
 * @param {any} prefill - input parameter.
 * @returns {any} Result.
 */
async function askExistingPathPrefill(rl, label, prefill) {
    const lbl = label.endsWith(':') ? label : `${label}:`;
    while (true) {
        const p = await askInlinePrefilled(rl, lbl, prefill || '');
        if (p && fs.existsSync(p)) return p;
        console.log(p ? `File not found: ${p}` : 'Please enter a file path.');
    }
}

const MAX_DEC19_6_ABS = 9999999999999.999999;
/**
 * clampDecimal19_6 — helper for generating representative values that respect SQL types/lengths and DECIMAL(19,6) caps.
 *
 * @param {any} n - input parameter.
 * @returns {any} Result.
 */
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

/* ================================ Exports ================================ */

// ---- Unified prompt factory ----
/**
 * makePrompts — utility helper; see implementation for details.
 *
 * @param {any} rl - input parameter.
 * @returns {any} Result.
 */
function makePrompts(rl) {
    if (!rl || typeof rl.question !== 'function') throw new Error('makePrompts requires a readline interface');
    const ask = (q) => new Promise(res => rl.question(q, ans => res((ans ?? '').trim())));

    /**
 * askPrefill — prompt in the CLI, showing defaults/prefill where applicable, and normalize the user's response.
 *
 * @param {any} label - input parameter.
 * @param {any} programmedDefault - input parameter.
 * @param {any} configValue - input parameter.
 * @returns {any} Result.
 */
    async function askPrefill(label, programmedDefault, configValue) {
        const shownDefault = programmedDefault ?? '';
        if (configValue !== undefined && configValue !== null && configValue !== '') rl.write(String(configValue));
        const ans = await ask(`${label} [${shownDefault}]: `);
        return ans === '' ? shownDefault : ans;
    }

    /**
 * askNumberPrefill — prompt in the CLI, showing defaults/prefill where applicable, and normalize the user's response.
 *
 * @param {any} label - input parameter.
 * @param {any} programmedDefault - input parameter.
 * @param {any} configValue - input parameter.
 * @returns {any} Result.
 */
    async function askNumberPrefill(label, programmedDefault, configValue) {
        if (configValue !== undefined && configValue !== null && configValue !== '') rl.write(String(configValue));
        const raw = await ask(`${label} [${String(programmedDefault)}]: `);
        const n = parseInt(raw, 10);
        return (!Number.isFinite(n) || n < 0) ? programmedDefault : n;
    }

    /**
 * askYesNoPrefill — prompt in the CLI, showing defaults/prefill where applicable, and normalize the user's response.
 *
 * @param {any} label - input parameter.
 * @param {any} programmedDefaultBool - input parameter.
 * @param {any} configYN - input parameter.
 * @returns {any} Result.
 */
    async function askYesNoPrefill(label, programmedDefaultBool, configYN) {
        const defChar = programmedDefaultBool ? 'Y' : 'N';
        if (configYN === 'Y' || configYN === 'N') rl.write(configYN);
        const a = (await ask(`${label} (y/N) [${defChar}]: `)).toLowerCase();
        if (!a) return programmedDefaultBool;
        if (a === 'y' || a === 'yes') return true;
        if (a === 'n' || a === 'no') return false;
        return programmedDefaultBool;
    }

    return { ask, askPrefill, askNumberPrefill, askYesNoPrefill };
}

module.exports = { makePrompts, 
    CONFIG_PATH,

    // CLI
    rlCreate, ask, askWithDefault, askYesNo, askInlinePrefilled,

    // JSONC I/O
    loadJsonc, saveJsonc,

    // Entity helpers
    listEntitiesCaseInsensitive, canonicalEntityKey, collectKeysDeep,

    // Filenames
    uniqueDatedFilename,

    // Generic helpers
    decode, formToObj, tryExtractJson,
    truncateUrl,
    percentile,
    clampIntForSqlType,
    askPrefill,
    shuffleInPlace,
    coerceAndNormalizeForChangelog,
    tsForFile,
    sqlLiteral,
    simpleEntityName,
    _sqlIntCapForType,
    toCsvField,
    refreshCompactJWT,
    ensureDirForFile,
    joinUrl,
    chooseByPercent,
    askExistingPathPrefill,
    localTsYmdHms,
    clampDecimal19_6,
    askNumberPrefill,
    askYesNoPrefill};
