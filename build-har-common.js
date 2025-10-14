/**
 * @file build-har-common.js
 * @summary Shared utility library for CLI prompts, JSONC I/O, entity helpers, and small generators.
 * @description Used by the config wizard, HAR generator, and HAR runner to keep UX and parsing consistent.
 */
"use strict";

const fs = require("fs");
const readline = require("readline");


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

function decode(bufOrStr) {
    if (Buffer.isBuffer(bufOrStr)) return bufOrStr.toString();
    return String(bufOrStr || "");
}
function formToObj(entries) {
    const out = {};
    for (const [k, v] of entries || []) out[k] = v;
    return out;
}
function tryExtractJson(s) {
    const m = String(s || "").match(/\{[\s\S]*}|\[[\s\S]*]/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

/* ============================ Deep key helpers ============================ */
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
function collectKeysDeep(obj) { return Object.keys(flattenToDotPaths(obj || {})); }

/* ================================ Exports ================================ */
module.exports = {
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

};
