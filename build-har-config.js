#!/usr/bin/env node
/**
 * @file build-har-config.js
 * @summary Interactive wizard for defining entity→API mappings (C mode).
 * @description Guides entity selection, schema discovery/merge from SQL, HAR-based route/wrapper learning,
 * and a review loop for TABLE/HEADERS/SUMMARY before saving the configuration.
 */


const fs = require('fs');
const {URL} = require('url');

const {
    CONFIG_PATH,


    rlCreate, askWithDefault, askYesNo, askInlinePrefilled,


    loadJsonc, saveJsonc,


    listEntitiesCaseInsensitive, canonicalEntityKey,


    collectKeysDeep, decode, formToObj, tryExtractJson,


    askExistingPathPrefill
} = require('./build-har-common');


/** Default banner text embedded in the saved JSONC config file. */
const DEFAULT_HEADER = `/*
------------------------------------------------------------------------------
 build-har.config — Entity → API mapping for HAR generation and replay

 CONTENTS
   • routes: base host, create/update paths, HTTP methods, and URL parameters.
   • payload: JSON wrapper key (if any) and required field names.
   • schema: columns discovered from SQL and how they map to API fields.
   • sources: last-used SQL and HAR file paths that produced this mapping.

PURPOSE
   The HAR generator reads this config to build and replay realistic API
   requests for testing and performance analysis.
------------------------------------------------------------------------------
*/`;


/**
 * Render a box-drawn ASCII table for the provided header row and data rows.
 * Computes per-column widths, draws borders, and prints one formatted line per row.
 *
 * @param {Array<string>} headers - Column headings.
 * @param {Array<Array<any>>} rows - Row values; each row index aligns to headers.
 * @returns {void}
 */
function printTable(headers, rows) {
    const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map(r => (String(r[i] ?? '')).length)));
    const pad = (s, w) => (String(s)).padEnd(w, ' ');
    const lineTop = '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
    const sep = '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
    const end = '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';
    console.log('');
    console.log(lineTop);
    console.log('│ ' + headers.map((h, i) => pad(h, widths[i])).join(' │ ') + ' │');
    console.log(sep);
    for (const r of rows) console.log('│ ' + r.map((c, i) => pad(c, widths[i])).join(' │ ') + ' │');
    console.log(end);
}


/**
 * Remove null/undefined static values from each schema row in the config.
 * Keeps only meaningful 'staticValue' entries so the saved JSONC stays compact.
 *
 * @param {Object} cfg - Full configuration object with entities and schema arrays.
 * @returns {Object} The same config object reference, cleaned in-place.
 */
function cleanNullStatics(cfg) {
    if (!cfg || !cfg.entities) return cfg;
    for (const ent of Object.values(cfg.entities)) {
        if (!ent || !Array.isArray(ent.schema)) continue;
        for (const col of ent.schema) {
            if (!col) continue;
            if (Object.prototype.hasOwnProperty.call(col, 'staticValue') && (col.staticValue === null || col.staticValue === undefined)) {
                delete col.staticValue;
            }
        }
    }
    return cfg;
}

/**
 * saveConfigClean — persist configuration after removing null/undefined “staticValue” entries.
 * Runs a targeted clean of schema rows, then writes the JSONC config to disk with a descriptive banner.
 *
 * @param {any} cfg - Full configuration object being saved.
 * @returns {any} The same configuration object reference.
 */
function saveConfigClean(cfg) {
    cleanNullStatics(cfg);
    saveJsonc(CONFIG_PATH, cfg, DEFAULT_HEADER);
}


/**
 * main — entry point for the config wizard.
 * Prompts for/chooses an entity, gathers SQL or HAR inputs when needed, drives the review loop,
 * and saves configuration on exit.
 */
(async function main() {
    const rl = rlCreate();
    try {

        console.log('\nThis utility creates a config file to be used by the .har generator.');
        console.log('It learns from a SQL CREATE TABLE example, and an existing .har file captured');
        console.log('in your browser’s network tool that performs a create and an update API call (xhr)');
        console.log('for the entity you are trying to define.\n');

        let cfg = loadJsonc(CONFIG_PATH) || {};
        cfg = cleanNullStatics(cfg);
        cfg.sourcesLastUsed = cfg.sourcesLastUsed || {sqlPath: '', harPath: ''};


        const {key: entityKey, isNew} = await pickEntityWithNewFlag(rl, cfg);
        const e = upsertEntity(cfg, entityKey);
        console.log('');

        if (!isNew) {
            const mdChoice = await askWithDefault(rl, `Do you want to (M)odify or (D)elete the entity "${entityKey}"? (M/D) [M]: `, 'M');

            if (/^d/i.test(mdChoice || '')) {
                const confirm = await askInlinePrefilled(rl, `Type DELETE to confirm deletion of ${entityKey}: `, '');
                if (confirm.trim().toUpperCase() === 'DELETE') {
                    delete cfg.entities[entityKey];
                    saveConfigClean(cfg);
                    console.log(`Entity "${entityKey}" deleted and configuration saved.`);
                    rl.close();
                    process.exit(0);
                } else {
                    console.log('Deletion canceled.');
                }
            }
        }

        console.log(`\nModifying entity ${entityKey}...\n`);


        const hadSchema = Array.isArray(e.schema) && e.schema.some(col => col && typeof col === 'object' && Object.keys(col).length > 0);

        if (!hadSchema) {
            console.log(`\nNo schema[] for entity ${entityKey}. SQL CREATE TABLE is required.`);
            await requireSql(rl, cfg, entityKey);
        } else {

            const doMerge = await askYesNo(rl, `Upload a new SQL CREATE TABLE to update stored schema for ${entityKey}?`, false);
            if (doMerge) {
                await optionalSqlMerge(rl, cfg, entityKey);
            } else {
                console.log(`Using existing schema for ${entityKey}. (Use TABLE later to edit/merge.)`);

            }
        }


        {
            const ent = cfg.entities[entityKey];
            const hasHarish = !!(ent?.routes?.host) || !!(ent?.routes?.create?.path) || !!(ent?.routes?.update?.path) || !!(ent?.payload?.create?.jsonPayloadWrapper) || !!(ent?.payload?.update?.jsonPayloadWrapper);

            if (!hasHarish) {
                console.log(`\nNo HAR-derived info for ${entityKey}. A HAR file is required to learn routes and payload shape.`);
                await harFlow(rl, cfg, entityKey);
            } else {
                console.log('');
                const wantHar = await askYesNo(rl, `Supply a sample HAR with API calls that create/update/get ${entityKey}?`, false);
                if (wantHar) {
                    await harFlow(rl, cfg, entityKey);
                } else {
                    console.log('');
                }
            }
        }


        console.log('');
        await reviewLoop(rl, cfg, entityKey);

    } catch (err) {
        console.error('\nFatal error:', err?.stack || err);
        process.exit(1);
    }
})();

/**
 * reviewLoop — interactive review flow for one entity.
 * Renders PREVIEW / HEADERS / QUERYSTRINGS / SUMMARY screens, accepts commands to open editors
 *
 * @param {any} rl - Readline interface for user prompts.
 * @param {any} cfg - Mutable configuration object.
 * @param {string} entityKey - Canonical key of the entity under review.
 * @returns {Promise<void>}
 */
async function reviewLoop(rl, cfg, entityKey) {
    while (true) {
        // Preview + detail sections
        printPreviewTable(cfg, entityKey);
        printHeaders(cfg.entities[entityKey], entityKey);
        printQueryStrings(cfg.entities[entityKey], entityKey);
        printSummary(cfg.entities[entityKey], entityKey);

        // Main menu
        console.log('\nEdit: TABLE (T), HEADERS (H), SUMMARY (S), QUERYSTRINGS (Q), or e[X]it & save.');
        const cmd = (await askWithDefault(rl, '> ', '')).trim().toUpperCase();

        if (!cmd) {
            continue;
        }

        // Exit/save (X)
        if (cmd === 'X' || cmd === 'EXIT' || cmd === 'SAVE' || cmd === 'SAVE&EXIT') {
            try {
                saveConfigClean(cfg);
                console.log('Configuration saved.');
            } catch (e) {
                console.log('Save failed:', e?.message || e);
            }
            try { rl.close(); } catch {}
            try { process.exit(0); } catch {}
            return; // in case process.exit is blocked
        }

        // Table editor (T)
        if (cmd === 'T' || cmd === 'TABLE') {
            try { await tableEditor(rl, cfg, entityKey); }
            catch (e) { console.log('TABLE editor error:', e?.message || e); }
            console.log('');
            continue;
        }

        // Headers editor (H)
        if (cmd === 'H' || cmd === 'HEADER' || cmd === 'HEADERS') {
            try { await headersEditor(rl, cfg, entityKey); }
            catch (e) { console.log('HEADERS editor error:', e?.message || e); }
            console.log('');
            continue;
        }

        // Summary editor (S)
        if (cmd === 'S' || cmd === 'SUMMARY') {
            try { await summaryPromptsOnce(rl, cfg.entities[entityKey], entityKey); }
            catch (e) { console.log('SUMMARY editor error:', e?.message || e); }
            console.log('');
            continue;
        }

        // NEW: QueryStrings editor (Q)
        if (cmd === 'Q' || cmd === 'QUERY' || cmd === 'QUERYSTRINGS') {
            try { await queryStringEditor(rl, cfg, entityKey); }
            catch (e) { console.log('QUERYSTRINGS editor error:', e?.message || e); }
            console.log('');
            continue;
        }

        console.log('Unknown command. Type T, H, S, Q, or X.');
    }
}



/**
 * upsertEntity — ensure an entity exists and is normalized.
 * Creates or updates routes, payload wrapper sections, and schema arrays; migrates legacy fields
 * and guarantees headers arrays exist for get/create/update sides.
 *
 * @param {any} cfg - Configuration object to mutate.
 * @param {string} key - Canonical entity key to get, create or update.
 * @returns {any} The updated entity object.
 */
function upsertEntity(cfg, key) {
    cfg.entities = cfg.entities || {};
    if (!cfg.entities[key]) {
        cfg.entities[key] = {
            routes: {
                host: null,
                create: { path: null, method: null, params: [], query: [], headers: [] },
                update: { path: null, method: null, params: [], query: [], headers: [] },
                get:    { path: null, method: 'GET',  params: [], query: [], headers: [] }
            },
            payload: {
                create: { jsonPayloadWrapper: null, requiredKeys: [] },
                update: { jsonPayloadWrapper: null, requiredKeys: [] }
            },
            schema: [],
            sources: { sqlPath: '', harPath: '' }
        };
    } else {
        const e = cfg.entities[key];

        // payload normalize
        const p = e.payload || (e.payload = {});
        for (const side of ['create', 'update']) {
            const obj = p[side] || (p[side] = {});
            if ('wrapper' in obj && !('jsonPayloadWrapper' in obj)) {
                obj.jsonPayloadWrapper = obj.wrapper || null;
                delete obj.wrapper;
            }
            if ('shape' in obj) delete obj.shape;
            if (!('requiredKeys' in obj)) obj.requiredKeys = [];
        }

        // routes normalize
        e.routes = e.routes || {};
        e.routes.create = e.routes.create || { path: null, method: null, params: [], headers: [] };
        e.routes.update = e.routes.update || { path: null, method: null, params: [], headers: [] };
        if (!('headers' in e.routes.create)) e.routes.create.headers = [];
        if (!('headers' in e.routes.update)) e.routes.update.headers = [];
        if (!('params'  in e.routes.create)) e.routes.create.params  = [];
        if (!('params'  in e.routes.update)) e.routes.update.params  = [];
        if (!('query'   in e.routes.create)) e.routes.create.query   = [];
        if (!('query'   in e.routes.update)) e.routes.update.query   = [];

        if (!e.routes.get) e.routes.get = { path: null, method: 'GET', params: [], query: [], headers: [] };
        if (!('headers' in e.routes.get))  e.routes.get.headers = [];
        if (!('params'  in e.routes.get))  e.routes.get.params  = [];
        if (!('query'   in e.routes.get))  e.routes.get.query   = [];
    }
    return cfg.entities[key];
}

/**
 * pickEntityWithNewFlag — choose an existing entity or create a new one.
 * Lists known entities with numeric shortcuts, accepts a name or number, and returns the
 * canonical key together with an isNew flag.
 *
 * @param {any} rl - Readline interface used for prompts.
 * @param {any} cfg - Configuration holding the entities map.
 * @returns {Promise<{ key: string, isNew: boolean }>}
 */
async function pickEntityWithNewFlag(rl, cfg) {
    while (true) {
        const items = listEntitiesCaseInsensitive(cfg);
        if (items.length) {
            console.log('Entities:');
            items.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${e}`));
        } else {
            console.log('No entities yet.');
        }

        console.log('   Q. Quit\n');

        const prompt = items.length ? 'Existing or New Entity name/number (or Q to quit): ' : 'Enter new entity name (or Q to quit): ';

        const input = (await askWithDefault(rl, prompt, items[0] || '')).trim();

        if (!input) {
            if (items.length) return {key: items[0], isNew: false};
            console.log('Please enter a name, a number, or Q to quit.');
            continue;
        }

        if (/^(q|quit)$/i.test(input)) {
            console.log('Canceled.');
            process.exit(0);
        }

        if (/^\d+$/.test(input) && items.length) {
            const n = parseInt(input, 10);
            if (n >= 1 && n <= items.length) return {key: items[n - 1], isNew: false};
            console.log('Invalid selection.');
            continue;
        }

        const canon = canonicalEntityKey(cfg, input);
        if (canon) return {key: canon, isNew: false};

        const ok = await askYesNo(rl, `Create new entity "${input}"?`, true);
        if (ok) return {key: input, isNew: true};
    }
}

/**
 * requireSql — prompt until a valid SQL CREATE TABLE is provided.
 * Accepts pasted SQL or a file path, parses it to seed the entity schema, and reports errors
 * with a gentle retry loop.
 *
 * @param {any} rl - Readline interface used for prompts.
 * @param {any} cfg - Configuration object to populate.
 * @param {string} entityKey - Entity to apply the parsed schema to.
 * @returns {Promise<void>}
 */
async function requireSql(rl, cfg, entityKey) {
    const e = cfg.entities[entityKey];
    while (true) {
        const prefill = (e.sources?.sqlPath || cfg.sourcesLastUsed?.sqlPath || '');
        const p = await askExistingPathPrefill(rl, `(${entityKey}) Path to SQL CREATE TABLE script`, prefill);
        const sql = fs.readFileSync(p, 'utf8');
        const parsed = tryParseSql(sql);
        if (parsed && parsed.columns.length) {
            rememberSourcePaths(cfg, entityKey, {sqlPath: p});
            mergeSchema(cfg, entityKey, parsed, {mode: 'require'});
            console.log(`\nHere's the Schema I found for ${entityKey}:`);
            printPreviewTable(cfg, entityKey);
            return;
        }
        console.log('Could not parse any columns. Please provide a valid CREATE TABLE.');
    }
}

/**
 * optionalSqlMerge — offer to merge a new CREATE TABLE into the existing schema.
 * If the user opts in, parses the supplied SQL and integrates column/PK changes into the entity,
 * then prints a concise summary of adds/updates/removals.
 *
 * @param {any} rl - Readline interface for user prompts.
 * @param {any} cfg - Configuration object to update.
 * @param {string} entityKey - Target entity key whose schema may be merged.
 * @returns {Promise<void>}
 */
async function optionalSqlMerge(rl, cfg, entityKey) {
    const e = cfg.entities[entityKey];
    const prefill = (e.sources?.sqlPath || cfg.sourcesLastUsed?.sqlPath || '');
    const p = await askExistingPathPrefill(rl, `(${entityKey}) Path to SQL CREATE TABLE script`, prefill);
    const sql = fs.readFileSync(p, 'utf8');
    const parsed = tryParseSql(sql);
    if (parsed && parsed.columns.length) {
        rememberSourcePaths(cfg, entityKey, {sqlPath: p});
        mergeSchema(cfg, entityKey, parsed, {mode: 'merge'});
        console.log(`\nHere's the Schema I found for ${entityKey}:`);
        printPreviewTable(cfg, entityKey);
    } else {
        console.log('⚠️  SQL parse failed; keeping existing schema untouched.');
    }
}

/**
 * tryParseSql — safely parse a SQL CREATE TABLE block.
 * Returns a normalized structure with columns and primary keys, or null when parsing fails
 * (so callers can loop and retry with better input).
 *
 * @param {string} sql - Raw CREATE TABLE text.
 * @returns {any|null} Parsed representation or null on error.
 */
function tryParseSql(sql) {
    try {
        return parseSqlCreate(sql);
    } catch (e) {
        console.log('SQL parse error:', e?.message || e);
        return null;
    }
}

/**
 * parseSqlCreate — convert a CREATE TABLE statement into structured metadata.
 * Extracts column names, types, length/precision/scale, and table/inline primary keys,
 * tolerating bracket/quoted identifiers and common dialect quirks.
 *
 * @param {string} sql - CREATE TABLE text to parse.
 * @returns {Object} Parsed table descriptor with columns[] and primaryKeys[].
 */
function parseSqlCreate(sql) {
    const input = String(sql).replace(/^\uFEFF/, '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ').replace(/\r\n/g, '\n');
    const ct = input.match(/create\s+table\s+(\[.*?]|".*?"|`.*?`|[\w.]+)/i);
    if (!ct) throw new Error('CREATE TABLE block not found.');
    const afterCt = input.slice(ct.index + ct[0].length);
    const firstParenRel = afterCt.indexOf('(');
    if (firstParenRel < 0) throw new Error('Opening "(" for CREATE TABLE not found.');
    const bodyStart = ct.index + ct[0].length + firstParenRel + 1;

    let i = bodyStart, depth = 1, inSQ = false, inDQ = false, inBQ = false, inBr = false;
    // Scan the CREATE TABLE text, tracking nesting to extract the statement body.
    while (i < input.length && depth > 0) {
        const ch = input[i], prev = input[i - 1];
        if (!inSQ && !inDQ && !inBQ) {
            if (ch === '[') inBr = true; else if (ch === ']') inBr = false;
        }
        if (!inBr) {
            if (!inDQ && !inBQ && ch === "'" && prev !== '\\') inSQ = !inSQ; else if (!inSQ && !inBQ && ch === '"' && prev !== '\\') inDQ = !inDQ; else if (!inSQ && !inDQ && ch === '`') inBQ = !inBQ;
        }
        if (!inSQ && !inDQ && !inBQ && !inBr) {
            if (ch === '(') depth++; else if (ch === ')') depth--;
        }
        i++;
    }
    if (depth !== 0) throw new Error('Could not find matching ")" of CREATE TABLE body.');
    const body = input.slice(bodyStart, i - 1).trim();

    const clauses = [];
    {
        let buf = '', d = 0, sQ = false, dQ = false, btQ = false, bQ = false;
        // Parse column/constraint tokens from the statement body and accumulate metadata.
        for (let k = 0; k < body.length; k++) {
            const ch = body[k], prev = body[k - 1];
            if (!sQ && !dQ && !btQ) {
                if (ch === '[') bQ = true; else if (ch === ']') bQ = false;
            }
            if (!bQ) {
                if (!dQ && !btQ && ch === "'" && prev !== '\\') sQ = !sQ; else if (!sQ && !btQ && ch === '"' && prev !== '\\') dQ = !dQ; else if (!sQ && !dQ && ch === '`') btQ = !btQ;
            }
            if (!sQ && !dQ && !btQ && !bQ) {
                if (ch === '(') d++; else if (ch === ')') d = Math.max(0, d - 1);
            }
            if (ch === ',' && d === 0 && !sQ && !dQ && !btQ && !bQ) {
                if (buf.trim()) clauses.push(buf.trim());
                buf = '';
                continue;
            }
            buf += ch;
        }
        if (buf.trim()) clauses.push(buf.trim());
    }

    const cols = [];
    const tablePk = [];

    /**
     * stripBrackets — remove surrounding [square] brackets from an identifier.
     *
     * @param {string} s - Input identifier.
     * @returns {string} Identifier without leading/trailing brackets.
     */
    const stripBrackets = s => s.replace(/^\[|]$/g, '');

    /**
     * stripQuotes — remove surrounding quote characters from an identifier.
     * Handles common SQL identifier quotes such as ", ', and `.
     *
     * @param {string} s - Input identifier.
     * @returns {string} Identifier without leading/trailing quotes.
     */
    const stripQuotes = s => s.replace(/^["'`]|["'`]$/g, '');


    for (let raw of clauses) {
        const line = raw.trim();
        const pkMatch = line.match(/^(?:constraint\s+\S+\s+)?primary\s+key\b[\s\S]*?\(([^)]+)\)/i);
        if (pkMatch) {
            pkMatch[1].split(',').forEach(chunk => {
                let col = chunk.trim().replace(/\bASC\b|\bDESC\b/ig, '').replace(/\s+/g, ' ').trim();
                const bracketed = col.match(/\[([^\]]+)]/);
                if (bracketed) col = bracketed[1]; else col = stripQuotes(col.split(/\s+/)[0]);
                if (col) tablePk.push(col);
            });
            continue;
        }
        if (/^(?:constraint\b|unique\b|foreign\b|check\b)/i.test(line)) continue;

        const m = line.match(/^([[\]"`.\w]+)\s+(\[[^\]]+]|[A-Za-z][A-Za-z0-9_]*)(?:\s*\(([^)]+)\))?/);
        if (!m) continue;

        const name = stripBrackets(m[1].split('.').pop());
        const rawType = stripBrackets(m[2]);
        const type = rawType.toUpperCase();
        const size = (m[3] || '').trim();

        let length = null, precision = null, scale = null;
        if (size) {
            if (/^\d+$/i.test(size)) length = parseInt(size, 10); else if (/^\d+\s*,\s*\d+$/i.test(size)) {
                const [p, s] = size.split(',').map(x => parseInt(x, 10));
                precision = p;
                scale = s;
                length = `${p},${s}`;
            } else if (/^max$/i.test(size)) length = 'MAX';
        }
        const inlinePk = /\bprimary\s+key\b/i.test(line);
        cols.push({name, type, length, precision, scale, inlinePk});
    }

    const primaryKeys = Array.from(new Set([...cols.filter(c => c.inlinePk).map(c => c.name), ...tablePk]));
    return {columns: cols, primaryKeys};
}

/**
 * mergeSchema — integrate parsed SQL columns/PKs into an entity’s schema.
 * Adds missing columns, updates types/lengths, sets PK/immutable flags, sorts with PKs first,
 * and respects the merge mode (e.g., add-only vs. reconcile).
 *
 * @param {any} cfg - Configuration to mutate.
 * @param {string} entityKey - Entity whose schema is being updated.
 * @param {Object} parsed - Output from parseSqlCreate/tryParseSql.
 * @param {Object} options - Options bag (e.g., { mode }).
 * @returns {any} Updated entity reference.
 */
function mergeSchema(cfg, entityKey, parsed, {mode}) {
    const e = cfg.entities[entityKey];
    const prev = Array.isArray(e.schema) ? e.schema : [];
    const pkSet = new Set(parsed.primaryKeys.map(x => x.toLowerCase()));
    const prevMap = new Map(prev.map(col => [col.name.toLowerCase(), col]));
    const merged = [];
    const added = [];
    const updated = [];

    for (const c of parsed.columns) {
        const key = c.name.toLowerCase();
        const existed = prevMap.get(key);
        if (!existed) {

            merged.push({
                name: c.name,
                type: c.type,
                length: c.length ?? (c.precision != null ? `${c.precision}${c.scale != null ? ',' + c.scale : ''}` : null),
                precision: c.precision ?? null,
                scale: c.scale ?? null,
                isPk: pkSet.has(key),
                immutable: pkSet.has(key),
                createApiField: "",
                updateApiField: "",
                serverGeneratedOnCreate: false
            });
            added.push(c.name);
        } else {
            const wasPk = !!existed.isPk;
            const nowPk = pkSet.has(key);
            const row = {
                ...existed,
                type: c.type,
                length: (c.length ?? (c.precision != null ? `${c.precision}${c.scale != null ? ',' + c.scale : ''}` : null)),
                precision: c.precision ?? null,
                scale: c.scale ?? null,
                isPk: nowPk,
                immutable: nowPk ? true : !!existed.immutable
            };
            if (wasPk !== nowPk || existed.type !== row.type || existed.length !== row.length || existed.precision !== row.precision || existed.scale !== row.scale) {
                updated.push(c.name);
            }
            merged.push(row);
        }
    }

    const newSet = new Set(parsed.columns.map(c => c.name.toLowerCase()));
    const dropped = prev.filter(col => !newSet.has(col.name.toLowerCase())).map(c => c.name);

    merged.sort((a, b) => (!!a.isPk !== !!b.isPk) ? (a.isPk ? -1 : 1) : String(a.name).localeCompare(String(b.name)));
    e.schema = merged;

    if (mode === 'merge') {
        console.log('\nSchema merge summary');
        if (added.length) console.log('  + Added columns:', added.join(', '));
        if (updated.length) console.log('  ~ Updated structure:', updated.join(', '));
        if (dropped.length) console.log('  - Dropped (missing in new SQL):', dropped.join(', '));
        if (!added.length && !updated.length && !dropped.length) console.log('  (no structural changes)');
    }
}

/**
 * summaryPromptsOnce — collect/confirm routing and wrapper details for both sides.
 * Prompts for host, method+path for create/update, id-parameter mapping for updates,
 * and optional JSON wrapper keys used to shape request/response bodies.
 *
 * @param {any} rl - Readline interface used for prompts.
 * @param {any} e - Entity object being configured.
 * @param {string} entityKey - Canonical key of the entity.
 * @returns {Promise<void>}
 */
async function summaryPromptsOnce(rl, e, entityKey) {
    // Ensure structure
    e.routes = e.routes || { host: null, create: {}, update: {}, get: {} };
    const routes = e.routes;

    // Make sure shells exist so prompts don’t crash
    routes.create = routes.create || { path: null, method: null, params: [], query: [], headers: [] };
    routes.update = routes.update || { path: null, method: null, params: [], query: [], headers: [] };
    routes.get    = routes.get    || { path: null, method: null, params: [], query: [], headers: [] };

    e.payload = e.payload || { create: {}, update: {} };
    e.payload.create = e.payload.create || { jsonPayloadWrapper: null, requiredKeys: [] };
    e.payload.update = e.payload.update || { jsonPayloadWrapper: null, requiredKeys: [] };

    console.log(`\nPlease edit or confirm for entity ${entityKey}:\n`);

    // Host (free-form; Enter keeps current)
    routes.host = await askInlinePrefilled(rl, `(${entityKey}) Host:`, routes.host || '');

    // Helper: verb prompt with constraints, no injected default.
    async function promptMethod(label, current) {
        const allowed = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
        while (true) {
            const raw = await askInlinePrefilled(rl, `(${entityKey}) ${label} method:`, (current || ''));
            const v = String(raw || '').trim();
            if (v === '') return current || null; // keep as-is (including blank)
            const up = v.toUpperCase();
            if (allowed.includes(up)) return up;
            console.log(`Invalid HTTP verb. Allowed: ${allowed.join(', ')}`);
        }
    }

    // Helper: prompt path (free-form; Enter keeps current)
    async function promptPath(label, current) {
        const raw = await askInlinePrefilled(rl, `(${entityKey}) ${label} path:`, (current || ''));
        return (raw ?? '');
    }

    // Helper: detect slug names from path (":id", ":fooBar")
    function extractSlugNames(path) {
        const m = String(path || '').match(/:([A-Za-z0-9_]+)/g) || [];
        return m.map(s => s.slice(1));
    }

    // Helper: walk each slug and prompt for its mapped schema column
    async function promptSlugMapping(label, path, existingParams) {
        const names = extractSlugNames(path);
        if (!names.length) return [];

        const existingMap = new Map((existingParams || []).map(p => [String(p?.name || '').toLowerCase(), p?.column || '']));

        const result = [];
        for (const n of names) {
            const cur = existingMap.get(n.toLowerCase()) || '';
            const picked = await askInlinePrefilled(rl, `(${entityKey}) ${label} slug ":${n}" maps to column:`, cur);
            result.push({ name: n, column: String(picked || '').trim() });
        }
        return result;
    }

    // ==== CREATE ====
    routes.create.method = await promptMethod('CREATE', routes.create.method);
    routes.create.path   = await promptPath('CREATE',  routes.create.path);
    if (routes.create.path) {
        routes.create.params = await promptSlugMapping('CREATE', routes.create.path, routes.create.params);
        const cwrap = await askInlinePrefilled(rl, `(${entityKey}) CREATE JSON payload wrapper (blank = none):`, e.payload.create.jsonPayloadWrapper || '');
        e.payload.create.jsonPayloadWrapper = cwrap ? cwrap : null;
    }

    // ==== UPDATE ====
    routes.update.method = await promptMethod('UPDATE', routes.update.method);
    routes.update.path   = await promptPath('UPDATE',  routes.update.path);
    if (routes.update.path) {
        routes.update.params = await promptSlugMapping('UPDATE', routes.update.path, routes.update.params);
        const currentPkParam = (routes.update.params && routes.update.params[0]) || {name: 'id', column: ''};
        let defaultPkColumn = currentPkParam.column || bestPkOrBlank(e);
        if (!defaultPkColumn) {
            defaultPkColumn = await promptForPkColumn(rl, e.schema, entityKey);
        }
        const pkCol = await askInlinePrefilled(
            rl,
            `(${entityKey}) PK column for existing ${entityKey}:`,
            defaultPkColumn || ''
        );
        routes.update.params = [{name: 'id', column: pkCol}];
        const uwrap = await askInlinePrefilled(rl, `(${entityKey}) UPDATE JSON payload wrapper (blank = none):`, e.payload.update.jsonPayloadWrapper || '');
        e.payload.update.jsonPayloadWrapper = uwrap ? uwrap : null;

    }

    // ==== GET ====
    routes.get.method = await promptMethod('GET', routes.get.method);
    routes.get.path   = await promptPath('GET',  routes.get.path);
    if (routes.get.path) {
        routes.get.params = await promptSlugMapping('GET', routes.get.path, routes.get.params);
    }

    console.log('');
}

/**
 * bestPkOrBlank — choose a primary key column if one is marked, else return "".
 * Scans the entity’s schema for a PK flag and returns the first match to aid ID mapping prompts.
 *
 * @param {any} entity - Entity whose schema is inspected.
 * @returns {string} Column name or empty string.
 */
function bestPkOrBlank(entity) {
    const schema = entity?.schema || [];
    const pk = schema.find(c => c.isPk);
    return pk ? pk.name : '';
}

/**
 * promptForPkColumn — let the user pick a primary key from the current schema.
 * Displays a numbered list of columns, validates the choice, and returns the selected column name.
 *
 * @param {any} rl - Readline interface used for prompts.
 * @param {Array<Object>} schema - Current schema rows.
 * @param {string} entityKey - Entity identifier for display context.
 * @returns {Promise<string>} Selected column name.
 */
async function promptForPkColumn(rl, schema, entityKey) {
    const cols = (schema || []).map(c => c.name);
    if (!cols.length) return '';
    console.log(`\n(${entityKey}) Select a primary key column:`);
    cols.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${n}`));
    const choice = await askWithDefault(rl, `(${entityKey}) PK column #`, '1');
    const idx = parseInt(choice, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < cols.length) return cols[idx];
    return cols[0];
}


/**
 * getSlugFillsForPath — map route slug placeholders to parameter→column pairs.
 * Parses a URL path such as `/api/users/:id` and returns an object that maps
 * each placeholder (e.g., `id`) to the configured column mapping, if present.
 *
 * @param {string} path - The route path possibly containing slugs.
 * @param {Array<Object>} paramsArr - List of parameter objects { name, column }.
 * @returns {Object} Mapping of slug name → column name.
 */
function getSlugFillsForPath(path, paramsArr) {
    const slugs = String(path || '').match(/:([A-Za-z0-9_]+)/g) || [];
    const nameOnly = slugs.map(s => s.slice(1));
    const map = {};
    for (const n of nameOnly) {
        const p = (paramsArr || []).find(x => String(x?.name).toLowerCase() === String(n).toLowerCase());
        map[n] = p?.column || '';
    }
    return map;
}

/**
 * printSummary — display current route and wrapper summary for an entity.
 * Prints host, create/update method+path, JSON wrapper keys, and id parameter
 * mapping, plus slug fill associations for create/update routes.
 *
 * @param {Object} e - The entity being summarized.
 * @param {string} entityKey - Canonical entity key for labeling.
 * @returns {void}
 */
function printSummary(e, entityKey) {
    const host = e?.routes?.host || '';

    const cm = (e?.routes?.create?.method || 'POST').toUpperCase();
    const cp = (e?.routes?.create?.path || '');

    const um = (e?.routes?.update?.method || 'POST').toUpperCase();
    const up = (e?.routes?.update?.path || '');
    const uparams = e?.routes?.update?.params || [];

    const gm = (e?.routes?.get?.method || 'GET').toUpperCase();
    const gp = (e?.routes?.get?.path || '');

    const cSlugMap = getSlugFillsForPath(cp, e?.routes?.create?.params || []);
    const uSlugMap = getSlugFillsForPath(up, uparams);
    const gSlugMap = getSlugFillsForPath(gp, e?.routes?.get?.params || []);

    const cSlugs = Object.keys(cSlugMap);
    const uSlugs = Object.keys(uSlugMap);
    const gSlugs = Object.keys(gSlugMap);

    console.log("");
    console.log(`Current SUMMARY for ${entityKey}:`);
    console.log(`  Host                                     : ${host}`);
    console.log("");
    console.log(`  CREATE route                             : ${cm} ${cp}`);
    if (cp) {
        if (cSlugs.length) {
            console.log('  slug fills :');
            for (const k of cSlugs) console.log(`    (create) :${k} ← ${cSlugMap[k] || '(not set)'}`);
        }
        const idParam = uparams[0];
        if (idParam) {
            const entLabel = entityKey || 'record';
            console.log(`  PK column for existing ${entLabel.padEnd(18)}: ${idParam.column || '(not set)'}`);
        }
        console.log(`  CREATE JSON payload data wrapper         : ${e?.payload?.create?.jsonPayloadWrapper || '(none)'}`);
    }
    console.log("");
    console.log(`  UPDATE route                             : ${um} ${up}`);
    if (up) {
        if (uSlugs.length) {
            console.log('    slug fills :');
            for (const k of uSlugs) console.log(`      (update) :${k} ← ${uSlugMap[k] || '(not set)'}`);
        }
        console.log(`  UPDATE JSON payload data wrapper         : ${e?.payload?.update?.jsonPayloadWrapper || '(none)'}`);
    }
    console.log("");
    console.log(`  GET route                                : ${gm} ${gp}`);
    if (gp) {
        if (gSlugs.length) {
            console.log('  slug fills :');
            for (const k of gSlugs) console.log(`    (get)    :${k} ← ${gSlugMap[k] || '(not set)'}`);
        }
    }
}

/**
 * Prints formatted tables of query string parameters for the given entity.
 *
 * This output mirrors the layout and style of printHeaders(), showing
 * up to three labeled tables for CREATE, UPDATE, and GET querystrings.
 *
 * @function printQueryStrings
 * @param {object} entity - The entity definition object containing route data.
 * @param {string} entityKey - The key (name) of the entity being printed.
 * @returns {void}
 *
 */
function printQueryStrings(entity, entityKey) {
    try {
        const cq = Array.isArray(entity?.routes?.create?.query) ? entity.routes.create.query : [];
        const uq = Array.isArray(entity?.routes?.update?.query) ? entity.routes.update.query : [];
        const gq = Array.isArray(entity?.routes?.get?.query)    ? entity.routes.get.query    : [];

        const sanitizeQuery = (arr) => {
            if (!Array.isArray(arr)) return [];
            return arr
                .map(q => ({
                    name:   String(q?.name ?? '').trim(),
                    column: (q && 'column' in q && q.column != null) ? String(q.column).trim() : undefined,
                    value:  (q && 'value'  in q && q.value  != null) ? String(q.value ).trim() : undefined
                }))
                .filter(q => q.name);
        };

        const signature = (arr) => {
            const rows = [];
            for (const q of sanitizeQuery(arr)) {
                rows.push([q.name.toLowerCase(), q.column ? `column:${q.column}` : `value:${q.value ?? ''}`]);
            }
            rows.sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
            return JSON.stringify(rows);
        };

        const cDisp = sanitizeQuery(cq);
        const uDisp = sanitizeQuery(uq);
        const gDisp = sanitizeQuery(gq);

        const sigC = signature(cq);
        const sigU = signature(uq);
        const sigG = signature(gq);

        const allEmpty = cDisp.length === 0 && uDisp.length === 0 && gDisp.length === 0;
        const allSame  = sigC === sigU && sigC === sigG;

        if (allSame) {
            console.log(`\nCurrent QUERYSTRINGS for ${entityKey} — All`);
            if (allEmpty) {
                console.log('(none)');
            } else {
                printTable(
                    ['#', 'Name', 'Mapping'],
                    cDisp.map((q,i)=>[String(i+1), q.name, q.column ? `column:${q.column}` : `value:${q.value ?? ''}`])
                );
            }
            return;
        }

        // Print each set separately
        console.log(`\nCurrent QUERYSTRINGS for ${entityKey} — CREATE`);
        if (cDisp.length) {
            printTable(['#', 'Name', 'Mapping'], cDisp.map((q,i)=>[String(i+1), q.name, q.column ? `column:${q.column}` : `value:${q.value ?? ''}`]));
        } else {
            console.log('(none)');
        }

        console.log(`\nCurrent QUERYSTRINGS for ${entityKey} — UPDATE`);
        if (uDisp.length) {
            printTable(['#', 'Name', 'Mapping'], uDisp.map((q,i)=>[String(i+1), q.name, q.column ? `column:${q.column}` : `value:${q.value ?? ''}`]));
        } else {
            console.log('(none)');
        }

        console.log(`\nCurrent QUERYSTRINGS for ${entityKey} — GET`);
        if (gDisp.length) {
            printTable(['#', 'Name', 'Mapping'], gDisp.map((q,i)=>[String(i+1), q.name, q.column ? `column:${q.column}` : `value:${q.value ?? ''}`]));
        } else {
            console.log('(none)');
        }
    } catch (e) {
        console.log(`\nCurrent QUERYSTRINGS for ${entityKey}:`);
        console.log('(error rendering querystrings table)');
    }
}

/**
 * printHeaders — render current request headers for an entity.
 * Displays tables for CREATE and UPDATE routes, showing name/value pairs,
 * and collapses to one table if the two header sets are identical.
 *
 * @param {Object} entity - Entity configuration containing routes.headers.
 * @param {string} entityKey - Entity key for output labeling.
 * @returns {void}
 */
function printHeaders(entity, entityKey) {
    try {
        const rawC = entity?.routes?.create?.headers || [];
        const rawU = entity?.routes?.update?.headers || [];
        const rawG = entity?.routes?.get?.headers    || [];

        const sanitizeDisplay = (arr) => {
            if (!Array.isArray(arr)) return [];
            return arr
                .map(h => ({
                    name: String(h?.name ?? '').trim(),
                    value: String(h?.value ?? '').trim()
                }))
                .filter(h => h.name);
        };

        const signature = (arr) => {
            const rows = [];
            for (const h of (Array.isArray(arr) ? arr : [])) {
                const name  = String(h?.name ?? '').trim().toLowerCase();
                const value = String(h?.value ?? '').trim();
                if (!name) continue;
                rows.push([name, value]);
            }
            rows.sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
            return JSON.stringify(rows);
        };

        const cDisp = sanitizeDisplay(rawC);
        const uDisp = sanitizeDisplay(rawU);
        const gDisp = sanitizeDisplay(rawG);
        const sigC = signature(rawC);
        const sigU = signature(rawU);
        const sigG = signature(rawG);

        const allEmpty = cDisp.length === 0 && uDisp.length === 0 && gDisp.length === 0;
        const allSame  = sigC === sigU && sigC === sigG;

        if (allSame) {
            console.log(`\nCurrent HEADERS for ${entityKey} — All`);
            if (allEmpty) {
                console.log('(none)');
            } else {
                const tableRows = cDisp.map((h, i) => [String(i + 1), h.name, h.value]);
                printTable(['#', 'Name', 'Value'], tableRows);
            }
            return;
        }

        // Print each set separately
        console.log(`\nCurrent HEADERS for ${entityKey} — CREATE`);
        if (cDisp.length) {
            printTable(['#', 'Name', 'Value'], cDisp.map((h,i)=>[String(i+1), h.name, h.value]));
        } else {
            console.log('(none)');
        }

        console.log(`\nCurrent HEADERS for ${entityKey} — UPDATE`);
        if (uDisp.length) {
            printTable(['#', 'Name', 'Value'], uDisp.map((h,i)=>[String(i+1), h.name, h.value]));
        } else {
            console.log('(none)');
        }

        console.log(`\nCurrent HEADERS for ${entityKey} — GET`);
        if (gDisp.length) {
            printTable(['#', 'Name', 'Value'], gDisp.map((h,i)=>[String(i+1), h.name, h.value]));
        } else {
            console.log('(none)');
        }

        const sameCU = sigC === sigU;
        const sameCG = sigC === sigG;
        const sameUG = sigU === sigG;

        if (!allSame && (sameCU || sameCG || sameUG)) {
            const pairs = [];
            if (sameCU) pairs.push('CREATE & UPDATE');
            if (sameCG) pairs.push('CREATE & GET');
            if (sameUG) pairs.push('UPDATE & GET');
            console.log(`\nNote: ${pairs.join(' | ')} headers are identical.`);
        }
    } catch (e) {
        console.log(`\nCurrent HEADERS for ${entityKey}:`);
        console.log('(error rendering headers table)');
    }
}

/**
 * harFlow — process a sample HAR file to auto-infer route structure and mappings.
 * Loads the HAR, extracts distinct hosts/routes, lets the user pick host and routes,
 * analyzes example entries to fill schema mappings, wrappers, and headers.
 *
 * @param {any} rl - Readline interface for prompts.
 * @param {Object} cfg - Full configuration object.
 * @param {string} entityKey - Entity being updated from HAR analysis.
 * @returns {Promise<void>}
 */
async function harFlow(rl, cfg, entityKey) {
    const ent = cfg.entities[entityKey];

    // HAR path prompt + remember
    const prefillHar = (ent.sources?.harPath || cfg.sourcesLastUsed?.harPath || '');
    const harPath = await askExistingPathPrefill(rl, `(${entityKey}) Path to sample HAR file`, prefillHar);
    rememberSourcePaths(cfg, entityKey, { harPath });
    saveConfigClean(cfg);

    // Load + summarize
    const har = loadHar(harPath);
    const entries = harvestEntries(har);
    const summary = harSummary(entries);

    // Host picker
    const hostChoice = await pickHostRequireChoice(rl, summary.hosts, entityKey);

    // CREATE candidates (POST-only for create UX)
    const createCandidates =
        (summary.routesByMethodPath['POST'] || []).concat(summary.routesByMethodPath['post'] || []);
    const createChoice = await pickRouteRequireChoice(
        rl,
        createCandidates,
        `CREATE API call example from the example har for ${entityKey}`
    );

    // UPDATE candidates (POST/PUT/PATCH)
    const updateCandidates = []
        .concat(summary.routesByMethodPath['POST']  || [])
        .concat(summary.routesByMethodPath['PUT']   || [])
        .concat(summary.routesByMethodPath['PATCH'] || []);
    const updateChoice = await pickRouteRequireChoice(
        rl,
        updateCandidates,
        `UPDATE API call example from the example har for ${entityKey}`
    );

    // Optional GET
    const getCandidates =
        (summary.routesByMethodPath['GET'] || []).concat(summary.routesByMethodPath['get'] || []);
    const getChoice = getCandidates.length
        ? await pickRouteRequireChoice(rl, getCandidates, `GET API call example from the example har for ${entityKey}`)
        : null;
    if (!getChoice) {
        console.log(`\n(No GET requests found in this HAR; you can set GET later via Summary/Query editors.)\n`);
    }

    // Normalize route shells (non-breaking)
    ent.routes = ent.routes || { host: null, create: {}, update: {}, get: { method: 'GET', params: [], query: [], headers: [] } };
    ent.routes.host = hostChoice;

    // CREATE path/method
    ent.routes.create = ent.routes.create || {};
    ent.routes.create.method = 'POST';
    ent.routes.create.path   = createChoice.path;

    // UPDATE path/method (preserve your display templating for /id/:id)
    ent.routes.update = ent.routes.update || {};
    ent.routes.update.method = (String(updateChoice.method || 'POST')).toUpperCase();
    ent.routes.update.path   = templateUpdatePathForDisplay(updateChoice.path);

    // GET path/method
    ent.routes.get = ent.routes.get || { method: 'GET', params: [], query: [], headers: [] };
    if (getChoice) {
        ent.routes.get.method = 'GET';
        ent.routes.get.path   = getChoice.path;
    }

    // Suggest headers from the most recent example for each chosen route (non-destructive)
    const chooseLatest = (m, p) => findMostRecentMatching(entries, m, p);
    const toHeaderArray = (hdrs) => sanitizeHeaders(hdrs || []);

    const cEntry = chooseLatest(ent.routes.create.method, createChoice.path);
    if (cEntry) {
        const cHeaders = toHeaderArray(cEntry?.req?.headers);
        if (Array.isArray(cHeaders) && cHeaders.length) ent.routes.create.headers = cHeaders;
    }

    const uEntry = chooseLatest(ent.routes.update.method, updateChoice.path);
    if (uEntry) {
        const uHeaders = toHeaderArray(uEntry?.req?.headers);
        if (Array.isArray(uHeaders) && uHeaders.length) ent.routes.update.headers = uHeaders;
    }

    if (getChoice) {
        const gEntry = chooseLatest('GET', getChoice.path);
        if (gEntry) {
            const gHeaders = toHeaderArray(gEntry?.req?.headers);
            if (Array.isArray(gHeaders) && gHeaders.length) ent.routes.get.headers = gHeaders;
        }
    }

    // === Restore old working behavior: analyze + applyAnalysis for CREATE/UPDATE ===
    try {
        if (cEntry) {
            const analysisC = analyzeSingleEntry(cEntry, ent, 'create');
            if (analysisC) applyAnalysis(ent, analysisC, 'create');
        }
        if (uEntry) {
            const analysisU = analyzeSingleEntry(uEntry, ent, 'update');
            if (analysisU) applyAnalysis(ent, analysisU, 'update');
        }
    } catch {
        // non-fatal
    }

    // Keep the helpful post-biasing that used to happen here
    try { if (typeof suggestUpdateIdParam === 'function') suggestUpdateIdParam(ent); } catch {}
    try { if (typeof biasServerGeneratedFromIdParam === 'function') biasServerGeneratedFromIdParam(ent); } catch {}
}

/**
 * loadHar — load and parse a HAR JSON file from disk.
 * Reads the file, parses JSON, validates structure, and returns the HAR object.
 * Throws an error if the file cannot be read or parsed.
 *
 * @param {string} path - File path to the HAR file.
 * @returns {Object} Parsed HAR object containing log.entries.
 */
function loadHar(path) {
    try {
        const raw = fs.readFileSync(path, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && obj.log && Array.isArray(obj.log.entries)) return obj;
    } catch (e) {
        throw new Error(`Failed to load HAR: ${e.message || e}`);
    }
}

/**
 * harvestEntries — flatten raw HAR entries into normalized records.
 * Extracts key fields (method, path, url, request, response) and filters out
 * entries lacking valid method/path values for later analysis.
 *
 * @param {Object} har - HAR object containing log.entries.
 * @returns {Array<Object>} Simplified list of request/response entries.
 */
function harvestEntries(har) {
    const entries = (har?.log?.entries || []).map(e => {
        const req = e.request || {};
        const res = e.response || {};
        const url = req.url || '';
        const method = (req.method || '').toUpperCase();
        let path;
        try {
            const u = new URL(url);
            path = u.pathname || '';
        } catch {
            path = url;
        }
        return {
            startedDateTime: e.startedDateTime, url, method, path, req, res
        };
    });
    return entries.filter(e => e.method && e.path);
}

/**
 * harSummary — summarize distinct hosts and route patterns in HAR entries.
 * Groups entries by method+path, deduplicates per combination, and
 * returns sets of hosts and routes keyed by HTTP method.
 *
 * @param {Array<Object>} entries - Normalized HAR entry list.
 * @returns {Object} Summary object { hosts, routesByMethodPath }.
 */
function harSummary(entries) {
    const hosts = new Set();
    const routesByMethodPath = {};
    for (const e of entries) {
        try {
            const u = new URL(e.url);
            hosts.add(`${u.protocol}//${u.host}`);
        } catch {
        }
        const key = e.method.toUpperCase();
        const arr = routesByMethodPath[key] || (routesByMethodPath[key] = []);
        if (!arr.some(r => r.path === e.path)) arr.push({ method: e.method, path: e.path });
    }
    return {hosts: Array.from(hosts), routesByMethodPath};
}

/**
 * pickHostRequireChoice — prompt the user to select a host from detected HAR hosts.
 * Displays all unique host options, auto-selects when only one exists, and returns
 * the chosen host string for later route analysis.
 *
 * @param {any} rl - Readline interface used for prompts.
 * @param {Array<string>} hosts - List of available host names.
 * @param {string} entityKey - Entity context for display.
 * @returns {Promise<string>} Selected host value.
 */
async function pickHostRequireChoice(rl, hosts, entityKey) {
    if (!hosts.length) throw new Error(`No hosts found in HAR for ${entityKey}.`);
    if (hosts.length === 1) return hosts[0];
    console.log(`\nHosts for ${entityKey}:`);
    hosts.forEach((h, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${h}`));
    const idx = parseInt(await askWithDefault(rl, `(${entityKey}) Pick host #`, '1'), 10) - 1;
    if (idx < 0 || idx >= hosts.length) return hosts[0];
    return hosts[idx];
}

/**
 * pickRouteRequireChoice — prompt the user to choose a route for a given method.
 * Lists all candidate routes with indices and descriptions, ensures a valid numeric
 * selection, and returns the chosen route object.
 *
 * @param {any} rl - Readline interface for prompts.
 * @param {Array<Object>} routes - Candidate route objects { method, path, count }.
 * @param {string} label - Display label such as "CREATE" or "UPDATE".
 * @returns {Promise<Object>} The selected route descriptor.
 */
async function pickRouteRequireChoice(rl, routes, label) {
    if (!routes.length) throw new Error(`No ${label} routes found.`);
    if (routes.length === 1) return routes[0];
    console.log(`\nFound routes:\n`);
    routes.forEach((r, i) => {
        const m = r.method || "—";
        console.log(`  ${String(i + 1).padStart(2, ' ')}. [${m}] ${r.path}`);
    });
    console.log("");
    const idx = parseInt(await askWithDefault(rl, `Pick ${label} route #`, '1'), 10) - 1;
    if (idx < 0 || idx >= routes.length) return routes[0];
    return routes[idx];
}

/**
 * findMostRecentMatching — locate the latest HAR entry for a given method+path.
 * Searches the list of normalized entries from newest to oldest and returns
 * the first matching record, or null if no match is found.
 *
 * @param {Array<Object>} entries - Normalized HAR entries.
 * @param {string} method - HTTP method to match.
 * @param {string} path - Route path to match.
 * @returns {Object|null} Matching HAR entry or null.
 */
function findMostRecentMatching(entries, method, path) {
    const m = String(method || '').toUpperCase();
    const arr = entries.filter(e => e.method === m && e.path === path);
    if (!arr.length) return null;
    arr.sort((a, b) => new Date(b.startedDateTime) - new Date(a.startedDateTime));
    return arr[0];
}

/**
 * sanitizeHeaders — clean and normalize a headers array.
 * Trims whitespace, lowercases keys, removes duplicates or forbidden header names,
 * and sorts results alphabetically for deterministic output.
 *
 * @param {Array<Object>} arr - Array of header objects { name, value }.
 * @returns {Array<Object>} Sanitized headers array.
 */
function sanitizeHeaders(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Map();

    for (const h of arr) {
        if (!h) continue;
        const name = String(h.name || '').trim().toLowerCase();
        if (!name) continue;
        if (name.startsWith(':')) continue;
        if (name === 'authorization') continue;
        if (name === 'content-length') continue;


        let value = String(h.value ?? '').trim().replace(/\s+/g, ' ');
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        seen.set(name, {name, value});
    }


    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * analyzeSingleEntry — derive mappings and wrapper info from one HAR entry.
 * Parses request/response JSON, extracts deep keys, infers likely wrapper path,
 * and builds a mapping context for the specified side ("create" or "update").
 *
 * @param {Object} entry - HAR entry to analyze.
 * @param {Object} entity - Target entity for mapping context.
 * @param {string} side - "create" or "update" side indicator.
 * @returns {Object} Analysis result with keys, wrapper, and examples.
 */
function analyzeSingleEntry(entry, entity, side) {
    const reqJson = parseReqBody(entry.req);
    const resJson = parseResBody(entry.res);


    const wrapperPath = findWrapper(reqJson, {returnPath: true});

    const unwrappedReq = wrapperPath ? unwrapByPath(reqJson, wrapperPath) : reqJson;
    const unwrappedRes = wrapperPath ? unwrapByPath(resJson, wrapperPath) : resJson;

    const reqLeafs = new Set(collectKeysDeep(unwrappedReq || {}));
    const resLeafs = new Set(collectKeysDeep(unwrappedRes || {}));
    const leafs = (obj) => collectKeysDeep(obj || {});
    const reqDeep = new Set(leafs(unwrappedReq));
    const resDeep = new Set(leafs(unwrappedRes));
    const headersSan = sanitizeHeaders(entry?.req?.headers);

    return {
        side,
        wrapper: wrapperPath ? String(wrapperPath).split('.').slice(-1)[0] : null,
        reqKeys: Array.from(reqLeafs),
        resKeys: Array.from(resLeafs),
        reqDeepKeys: Array.from(reqDeep),
        resDeepKeys: Array.from(resDeep),
        exampleReq: unwrappedReq || {},
        exampleRes: resJson || {},
        headers: headersSan
    };

    /**
     * unwrapByPath — return a nested value by dotted wrapper path.
     * Walks the object by segments (e.g., "data.item") and returns the value or null.
     *
     * @param {object} obj - Source object.
     * @param {string} path - Dotted path to unwrap.
     * @returns {any} Located value or null.
     */
    function unwrapByPath(obj, path) {
        if (!obj || typeof obj !== 'object') return obj;
        const parts = String(path).split('.').filter(Boolean);
        let cur = obj;
        for (const p of parts) {
            if (!cur || typeof cur !== 'object') return obj;
            cur = cur[p];
        }
        return cur ?? obj;
    }
}

/**
 * parseReqBody — extract and parse the request payload from a HAR entry.
 * Handles both JSON and URL-encoded forms, returning a plain object
 * for key-mapping analysis.
 *
 * @param {Object} req - HAR request object.
 * @returns {Object} Parsed request body or {} when unavailable.
 */
function parseReqBody(req) {
    const pd = req?.postData || {};
    if (!pd || !pd.text) return {};
    let txt = decode(pd.text);
    const json = tryExtractJson(txt);
    if (json) return json;

    if (pd.mimeType && /x-www-form-urlencoded/i.test(pd.mimeType) && Array.isArray(pd.params)) {
        return formToObj(pd.params.map(p => [p.name, p.value]));
    }
    return {};
}

/**
 * parseResBody — extract and parse the response payload from a HAR entry.
 * Supports JSON only; safely catches parsing errors and returns an empty
 * object if the body cannot be parsed.
 *
 * @param {Object} res - HAR response object.
 * @returns {Object} Parsed response JSON or {}.
 */
function parseResBody(res) {
    const c = res?.content || {};
    if (!c || !c.text) return {};
    const txt = decode(c.text);
    const json = tryExtractJson(txt);
    return json || {};
}

/**
 * findWrapper — detect a JSON wrapper key or dotted path inside a parsed body.
 * Scans nested objects for common container keys like "data", "result", or "value",
 * and returns the most likely wrapper string path or null if not found.
 *
 * @param {Object} obj - Parsed JSON object to inspect.
 * @param {Object} [options] - Optional heuristics settings.
 * @returns {string|null} Detected wrapper path or null.
 */
function findWrapper(obj, options) {
    const returnPath = !!(options && options.returnPath);

    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    const norm = (s) => String(s || "").trim().toLowerCase();
    const relax = (s) => norm(s).replace(/[^a-z0-9]/g, "");

    if (!isObj(obj)) return null;

    const keys = Object.keys(obj);
    if (!keys.length) return null;

    // 1) Trivial single-key envelope: { data: {...} }
    if (keys.length === 1 && isObj(obj[keys[0]])) {
        return returnPath ? keys[0] : keys[0];
    }

    // Build quick lookup tables (used by heuristics below)
    const mapNormToKey = new Map(keys.map((k) => [norm(k), k]));
    const relaxedToKey = new Map(keys.map((k) => [relax(k), k]));

    // 2) Common envelope/container names (alias-free)
    const containers = ["data", "payload", "entity", "request", "item", "record", "attributes", "wrapper", "envelope", "result", "results", "response", "body",];

    for (const hint of containers) {
        if (mapNormToKey.has(hint) && isObj(obj[mapNormToKey.get(hint)])) {
            const k = mapNormToKey.get(hint);
            // Recurse one level to allow nested wrapper discovery: { data: { item: {...} } }
            const inner = findWrapper(obj[k], {returnPath: true});
            if (inner) return returnPath ? `${k}.${inner}` : k;
            return returnPath ? k : k;
        }
    }

    // 3) Arrays of objects—typical for list endpoints: { people: [{...}, {...}] }
    for (const k of keys) {
        const v = obj[k];
        if (Array.isArray(v) && v.length && isObj(v[0])) {
            return returnPath ? k : k;
        }
    }

    // 4) Double-nested same-key heuristic: { person: { person: {...} } }
    for (const k of keys) {
        const v = obj[k];
        if (isObj(v) && Object.prototype.hasOwnProperty.call(v, k) && isObj(v[k])) {
            const path = `${k}.${k}`;
            return returnPath ? path : k;
        }
    }

    // 5) Relaxed-name probe: prefer keys whose relaxed form looks container-ish
    const relaxedContainerHints = containers.map(relax);
    for (const hint of relaxedContainerHints) {
        if (relaxedToKey.has(hint) && isObj(obj[relaxedToKey.get(hint)])) {
            const k = relaxedToKey.get(hint);
            const inner = findWrapper(obj[k], {returnPath: true});
            if (inner) return returnPath ? `${k}.${inner}` : k;
            return returnPath ? k : k;
        }
    }

    // 6) Fallback: first object-valued key
    for (const k of keys) {
        if (isObj(obj[k])) {
            return returnPath ? k : k;
        }
    }

    return null;
}

/**
 * inferServerGeneratedFields — mark likely server-generated fields in the schema.
 * Compares request vs. response data to find keys that appear only in responses
 * or match timestamp/id patterns, setting their immutable/server flags.
 *
 * @param {Object} entity - Entity object whose schema is updated.
 * @param {Object} analysis - Combined request/response key analysis.
 * @returns {void}
 */
function inferServerGeneratedFields(entity, analysis) {
    const reqSet = new Set((analysis.reqDeepKeys || []).map(k => String(k).toLowerCase()));
    const resSet = new Set((analysis.resDeepKeys || []).map(k => String(k).toLowerCase()));

    /**
     * getCaseInsensitive — retrieve a property from an object case-insensitively.
     *
     * @param {object} obj - Source object.
     * @param {string} key - Property name to look up.
     * @returns {any} Value found or undefined.
     */
    const getCaseInsensitive = (obj, key) => {
        if (!obj || !key) return undefined;
        if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
        const lower = String(key).toLowerCase();
        for (const k of Object.keys(obj)) {
            if (String(k).toLowerCase() === lower) return obj[k];
        }
        return undefined;
    };

    /**
     * isNonEmptyEvidence — determine whether a value is meaningful evidence.
     * Treats null/undefined/empty strings as non-evidence; arrays/objects must be non-empty.
     *
     * @param {any} v - Value to evaluate.
     * @returns {boolean} True when the value should count as evidence.
     */
    const isNonEmptyEvidence = (v) => {
        if (v == null) return false;
        if (typeof v === 'string' && v.trim() === '') return false;
        return v !== 0;

    };

    /**
     * nameLooksStamped — decide if a column name implies server time/id stamping.
     * Flags common patterns like 'createdAt', 'updatedOn', or GUID-like names.
     *
     * @param {string} lowerName - Lowercased column name.
     * @returns {boolean} True if the name looks server-generated.
     */
    const nameLooksStamped = (lowerName) => {
        return (lowerName.startsWith('created') || lowerName.startsWith('modified') || lowerName.startsWith('updated') || lowerName.includes('timestamp') || lowerName === 'rowversion' || lowerName === 'ts' || lowerName === 'ctime' || lowerName === 'mtime');
    };

    for (const col of (entity.schema || [])) {
        const nameLower = String(col.name || '').toLowerCase();

        const mappedCreate = String(col.createApiField || '').toLowerCase();
        const mappedUpdate = String(col.updateApiField || '').toLowerCase();

        const inReqCreate = mappedCreate && reqSet.has(mappedCreate);
        const inResCreate = mappedCreate && resSet.has(mappedCreate);
        const inReqUpdate = mappedUpdate && reqSet.has(mappedUpdate);
        const inResUpdate = mappedUpdate && resSet.has(mappedUpdate);

        const resCreateVal = getCaseInsensitive(analysis.exampleRes, col.createApiField || '');
        const resUpdateVal = getCaseInsensitive(analysis.exampleRes, col.updateApiField || '');
        const hasNonEmptyResCreate = inResCreate && isNonEmptyEvidence(resCreateVal);
        const hasNonEmptyResUpdate = inResUpdate && isNonEmptyEvidence(resUpdateVal);

        const looksServerGenerated = (!inReqCreate && (hasNonEmptyResCreate || nameLooksStamped(nameLower))) || (!inReqUpdate && (hasNonEmptyResUpdate || nameLooksStamped(nameLower))) || nameLooksStamped(nameLower);

        if (looksServerGenerated) {
            col.serverGeneratedOnCreate = true;
            if (!inReqCreate) col.createApiField = '';
            if (!inReqUpdate && inResUpdate) col.updateApiField = '';
            if (nameLooksStamped(nameLower)) col.immutable = true;
        }
    }
}

/**
 * fillMappingsFromKeysDeep — auto-populate API field mappings from leaf keys.
 * Iterates through all deep keys discovered in request/response bodies and fills
 * missing mapping values in the schema for the specified side.
 *
 * @param {Array<Object>} schema - Schema rows to update.
 * @param {Object} analysis - Key analysis result.
 * @param {string} side - "create" or "update".
 * @returns {void}
 */
function fillMappingsFromKeysDeep(schema, analysis, side) {

    const reqLeaves = new Set((analysis.reqKeys || []).map(k => String(k).toLowerCase()));
    const resLeaves = new Set((analysis.resKeys || []).map(k => String(k).toLowerCase()));

    for (const col of schema) {
        const nameLower = String(col.name || '').toLowerCase();

        let match = exactLeafMatch(nameLower, reqLeaves);
        if (!match) match = exactLeafMatch(nameLower, resLeaves);

        if (side === 'create') {
            if (!col.createApiField || !String(col.createApiField).trim()) col.createApiField = match;
        } else {
            if (!col.updateApiField || !String(col.updateApiField).trim()) col.updateApiField = match;
        }
    }
}

/**
 * exactLeafMatch — check if a schema column name matches any leaf key exactly.
 * Performs a case-insensitive comparison and returns true on the first hit.
 *
 * @param {string} colNameLower - Column name (lowercased).
 * @param {Set<string>} leafSet - Set of deep key names (lowercased).
 * @returns {boolean} True if matched, else false.
 */
function exactLeafMatch(colNameLower, leafSet) {
    if (!leafSet || !leafSet.size) return '';

    for (const k of colNameLower) if (leafSet.has(k)) return k;
    for (const k of leafSet) {
        if (k === colNameLower) return k;
    }
    return '';
}

/**
 * templateUpdatePathForDisplay — show a readable update path with ':id' placeholder.
 * Replaces a trailing numeric or GUID segment with ':id' for user-friendly display.
 *
 * @param {string} path - Original update route path.
 * @returns {string} Path string with ':id' substitution if applicable.
 */
function templateUpdatePathForDisplay(path) {
    const segs = String(path || '').split('/').filter(Boolean);
    if (segs.length >= 4 && segs[segs.length - 2].toLowerCase() === 'id') {
        segs[segs.length - 1] = ':id';
        return '/' + segs.join('/');
    }
    return path || '';
}

/**
 * suggestUpdateIdParam — set the entity’s update id parameter if unset.
 * Uses the primary key column when present to fill the idParam field automatically.
 *
 * @param {Object} entity - Entity object being edited.
 * @returns {void}
 */
function suggestUpdateIdParam(entity) {
    const schema = entity?.schema || [];
    const pkCol = schema.find(c => c.isPk)?.name || '';
    if (!entity.routes) entity.routes = {update: {params: []}};
    if (!entity.routes.update) entity.routes.update = {params: []};
    const idParam = (entity.routes.update.params && entity.routes.update.params[0]) || {name: 'id', column: ''};
    const chosen = idParam.column || pkCol || '';
    entity.routes.update.params = [{name: 'id', column: chosen}];
}

/**
 * biasServerGeneratedFromIdParam — bias PK column as server-generated when used as idParam.
 * Ensures primary key columns tied to update id parameters are marked immutable/server-generated.
 *
 * @param {Object} entity - Entity whose schema flags may be updated.
 * @returns {void}
 */
function biasServerGeneratedFromIdParam(entity) {
    const idParam = entity?.routes?.update?.params?.[0];
    if (!idParam) return;
    const col = (entity.schema || []).find(c => c.name === idParam.column);
    if (!col) return;
    col.serverGeneratedOnCreate = true;
    col.immutable = true;
}

/**
 * rememberSourcePaths — record last-used SQL/HAR paths for reuse.
 * Saves the provided source paths both within the entity object and
 * at the top level of the configuration.
 *
 * @param {Object} cfg - Configuration object.
 * @param {string} entityKey - Entity key being updated.
 * @param {Object} paths - Object containing sqlPath and harPath.
 * @returns {void}
 */
function rememberSourcePaths(cfg, entityKey, paths) {
    if (!cfg || !entityKey || !paths || typeof paths !== 'object') return;

    cfg.entities = cfg.entities || {};
    const ent = cfg.entities[entityKey] || (cfg.entities[entityKey] = {});
    ent.sources = ent.sources || {sqlPath: '', harPath: ''};
    cfg.sourcesLastUsed = cfg.sourcesLastUsed || {sqlPath: '', harPath: ''};

    if (paths.sqlPath != null && String(paths.sqlPath).trim() !== '') {
        const p = String(paths.sqlPath).trim();
        ent.sources.sqlPath = p;
        cfg.sourcesLastUsed.sqlPath = p;
    }

    if (paths.harPath != null && String(paths.harPath).trim() !== '') {
        const p = String(paths.harPath).trim();
        ent.sources.harPath = p;
        cfg.sourcesLastUsed.harPath = p;
    }
}

/**
 * headersEditor — header-only editor invoked from the main T/H/S/Q/X menu.
 * Scope selection once (C/U/G/A). No inner route switching.
 * In A mode, edits apply to C+U+G immediately.
 * Legend matches the main Table editor:
 *   <#|name> to edit, [A]DD, [D]EL #|name, X
 */
async function headersEditor(rl, cfg, entityKey) {
    const ent = cfg.entities[entityKey];

    // Ensure scaffolds
    ent.routes = ent.routes || {
        create: { headers: [], params: [], query: [] },
        update: { headers: [], params: [], query: [] },
        get:    { method: 'GET', headers: [], params: [], query: [] }
    };
    for (const k of ['create','update','get']) {
        ent.routes[k] = ent.routes[k] || {};
        ent.routes[k].headers = Array.isArray(ent.routes[k].headers) ? ent.routes[k].headers : [];
        ent.routes[k].params  = Array.isArray(ent.routes[k].params)  ? ent.routes[k].params  : [];
        ent.routes[k].query   = Array.isArray(ent.routes[k].query)   ? ent.routes[k].query   : [];
        if (!ent.routes[k].method && k === 'get') ent.routes[k].method = 'GET';
    }

    // Choose scope once
    const scopeAns = (await askWithDefault(
        rl,
        `Edit which headers? (C)REATE, (U)PDATE, (G)ET, or (A)LL [A]:`,
        'A'
    )).trim().toUpperCase();
    const scope = scopeAns.startsWith('C') ? 'C'
        : scopeAns.startsWith('U') ? 'U'
            : scopeAns.startsWith('G') ? 'G'
                : 'A';

    // Helpers
    function sanitizeHeaders(arr) {
        if (!Array.isArray(arr)) return [];
        const seen = new Set();
        const out = [];
        for (const h of arr) {
            const name = String(h?.name ?? '').trim();
            const value = String(h?.value ?? '').trim();
            if (!name) continue;
            const key = name.toLowerCase() + '\u0001' + value;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ name, value });
        }
        return out;
    }
    function showTable(label, arr) {
        const rows = (arr || []).map((h, i) => [String(i + 1), h?.name || '', h?.value || '']);
        console.log(`\nHEADERS — ${entityKey} / ${label}`);
        if (rows.length) printTable(['#', 'Name', 'Value'], rows); else console.log('(none)');
        console.log('\nCommands:');
        console.log('<row# | name>      (starts interactive edit for that row)');
        console.log('[A]DD              (append a new blank row, then prompt for its values)');
        console.log('[D]EL #|name       (delete that row; asks for confirmation)');
        console.log('X                  (e[X]it Header Editor)');
    }
    function resolveIndexByToken(arr, token) {
        if (!arr || !arr.length) return -1;
        const t = String(token ?? '').trim();
        if (!t) return -1;
        const maybe = Number(t);
        if (Number.isInteger(maybe) && maybe >= 1 && maybe <= arr.length) return maybe - 1;
        const wanted = t.toLowerCase();
        for (let i = 0; i < arr.length; i++) {
            const nm = String(arr[i]?.name ?? '').toLowerCase();
            if (nm === wanted) return i;
        }
        return -1;
    }
    async function addItem(arr) {
        const name  = await askInlinePrefilled(rl, `(${entityKey}) Header name:`, '');
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        const value = await askInlinePrefilled(rl, `(${entityKey}) Header value:`, '');
        arr.push({ name: trimmed, value: String(value || '').trim() });
    }
    async function editItemAt(arr, idx) {
        const cur   = arr[idx] || {};
        const name  = await askInlinePrefilled(rl, `(${entityKey}) Header name:`,  cur?.name  || '');
        const value = await askInlinePrefilled(rl, `(${entityKey}) Header value:`, cur?.value || '');
        if (String(name).trim()) arr[idx] = { name: String(name).trim(), value: String(value || '').trim() };
    }
    async function deleteItemAt(arr, idx) {
        const confirm = await askYesNo(rl, `Delete row ${idx + 1}?`, false);
        if (confirm) arr.splice(idx, 1);
    }

    // ===== ALL mode =====
    if (scope === 'A') {
        const sizes = [
            ['create', ent.routes.create.headers.length],
            ['update', ent.routes.update.headers.length],
            ['get',    ent.routes.get.headers.length],
        ].sort((a,b) => b[1]-a[1]);
        let all = JSON.parse(JSON.stringify(ent.routes[sizes[0][0]].headers || []));
        const applyAll = () => {
            all = sanitizeHeaders(all);
            ent.routes.create.headers = JSON.parse(JSON.stringify(all));
            ent.routes.update.headers = JSON.parse(JSON.stringify(all));
            ent.routes.get.headers    = JSON.parse(JSON.stringify(all));
        };
        applyAll();

        while (true) {
            showTable('ALL', all);
            const line = (await askWithDefault(rl, 'Command (#,A,D,X)', '')).trim();
            if (!line) continue;
            const parts = line.split(/\s+/, 2);
            const cmd = parts[0].toUpperCase();

            if (cmd === 'X' || cmd === 'EXIT') break;

            if (cmd === 'A' || cmd === 'ADD') {
                await addItem(all); applyAll(); continue;
            }
            if (cmd === 'D' || cmd === 'DEL') {
                const idx = resolveIndexByToken(all, parts[1]);
                if (idx >= 0) { await deleteItemAt(all, idx); applyAll(); }
                else console.log('Row not found. Use a row number or exact header name.');
                continue;
            }

            // Otherwise treat the input as an edit token (<#|name>)
            const idx = resolveIndexByToken(all, line);
            if (idx >= 0) { await editItemAt(all, idx); applyAll(); }
            else console.log('Unknown command. Use <#|name>, A, D <#|name>, or X.');
        }
        applyAll();
        return;
    }

    // ===== Single-route mode (C/U/G) =====
    const k = (scope === 'U') ? 'update' : (scope === 'G' ? 'get' : 'create');
    let arr = ent.routes[k].headers;

    while (true) {
        showTable(k.toUpperCase(), arr);
        const line = (await askWithDefault(rl, 'Command (#,A,D,X)', '')).trim();
        if (!line) continue;
        const parts = line.split(/\s+/, 2);
        const cmd = parts[0].toUpperCase();

        if (cmd === 'X' || cmd === 'EXIT') break;

        if (cmd === 'A' || cmd === 'ADD') {
            await addItem(arr);
            arr = sanitizeHeaders(arr);
            ent.routes[k].headers = arr;
            continue;
        }
        if (cmd === 'D' || cmd === 'DEL') {
            const idx = resolveIndexByToken(arr, parts[1]);
            if (idx >= 0) { await deleteItemAt(arr, idx); }
            else console.log('Row not found. Use a row number or exact header name.');
            arr = sanitizeHeaders(arr);
            ent.routes[k].headers = arr;
            continue;
        }

        // Otherwise treat input as edit token
        const idx = resolveIndexByToken(arr, line);
        if (idx >= 0) {
            await editItemAt(arr, idx);
            arr = sanitizeHeaders(arr);
            ent.routes[k].headers = arr;
        } else {
            console.log('Unknown command. Use <#|name>, A, D <#|name>, or X.');
        }
    }

    ent.routes[k].headers = sanitizeHeaders(ent.routes[k].headers);
}

/**
 * queryStringEditor — per-route (or All when identical) query param editor.
 * Scope selection once (C/U/G, or A only if all three sets are identical).
 * No inner route switching. Legend matches main Table editor:
 *   <#|name> to edit, [A]DD, [D]EL #|name, X
 */
async function queryStringEditor(rl, cfg, entityKey) {
    const ent = cfg.entities[entityKey];
    ent.routes = ent.routes || {};
    ent.routes.create = ent.routes.create || { query: [] };
    ent.routes.update = ent.routes.update || { query: [] };
    ent.routes.get    = ent.routes.get    || { method: 'GET', query: [] };

    for (const k of ['create','update','get']) {
        ent.routes[k].query = Array.isArray(ent.routes[k].query) ? ent.routes[k].query : [];
    }

    // Signature equality (case-insensitive names; mapping string)
    const normSig = (arr) => {
        const rows = [];
        for (const q of (Array.isArray(arr) ? arr : [])) {
            const name = String(q?.name ?? '').trim().toLowerCase();
            if (!name) continue;
            const mapping = (q && 'column' in q && q.column != null)
                ? `column:${String(q.column).trim()}`
                : `value:${String(q?.value ?? '').trim()}`;
            rows.push([name, mapping]);
        }
        rows.sort((a,b)=> a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
        return JSON.stringify(rows);
    };
    const sigC = normSig(ent.routes.create.query);
    const sigU = normSig(ent.routes.update.query);
    const sigG = normSig(ent.routes.get.query);
    const allSame = (sigC === sigU && sigC === sigG);

    const scopePrompt = allSame
        ? `Edit which querystrings? (C)REATE, (U)PDATE, (G)ET, or (A)LL [U]: `
        : `Edit which querystrings? (C)REATE, (U)PDATE, or (G)ET [U]: `;
    const scopeAns = (await askWithDefault(rl, scopePrompt, 'U')).trim().toUpperCase();
    const scope = (allSame && scopeAns.startsWith('A')) ? 'A'
        : scopeAns.startsWith('C') ? 'C'
            : scopeAns.startsWith('G') ? 'G'
                : 'U';

    // UI helpers
    function printOne(label, arr) {
        const rows = (arr || []).map((q, i) => [
            String(i + 1),
            String(q?.name ?? ''),
            (q && 'column' in q && q.column != null)
                ? `column:${String(q.column)}`
                : `value:${String(q?.value ?? '')}`
        ]);
        console.log(`\nQUERYSTRINGS — ${entityKey} / ${label}`);
        if (rows.length) printTable(['#','Name','Mapping'], rows); else console.log('(none)');
        console.log('\nCommands:');
        console.log('<row# | name>      (starts interactive edit for that row)');
        console.log('[A]DD              (append a new blank row, then prompt for its values)');
        console.log('[D]EL #|name       (delete that row; asks for confirmation)');
        console.log('X                  (e[X]it QueryStrings Editor)');
    }
    function resolveIndexByToken(arr, token) {
        if (!arr || !arr.length) return -1;
        const t = String(token ?? '').trim();
        if (!t) return -1;
        const maybe = Number(t);
        if (Number.isInteger(maybe) && maybe >= 1 && maybe <= arr.length) return maybe - 1;
        const wanted = t.toLowerCase();
        for (let i = 0; i < arr.length; i++) {
            const nm = String(arr[i]?.name ?? '').toLowerCase();
            if (nm === wanted) return i;
        }
        return -1;
    }
    async function addItem(arr) {
        const name = await askInlinePrefilled(rl, 'Querystring Parameter name:', '');
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        const mapToCol = await askYesNo(rl, `Map "${trimmed}" to a schema column?`, false);
        if (mapToCol) {
            const column = await askInlinePrefilled(rl, 'Column name:', '');
            arr.push({ name: trimmed, column: String(column || '').trim() });
        } else {
            const value = await askInlinePrefilled(rl, 'Static value:', '');
            arr.push({ name: trimmed, value: String(value || '').trim() });
        }
    }
    async function editItemAt(arr, idx) {
        const cur = arr[idx] || {};
        const name = await askInlinePrefilled(rl, 'Querystring Parameter name:', cur.name || '');
        const useCol = await askYesNo(rl, `Map "${name}" to a schema column?`, !!cur.column);
        if (useCol) {
            const column = await askInlinePrefilled(rl, 'Column name:', cur.column || '');
            arr[idx] = { name, column: String(column || '').trim() };
        } else {
            const value = await askInlinePrefilled(rl, 'Static value:', cur.value || '');
            arr[idx] = { name, value: String(value || '').trim() };
        }
    }
    async function deleteItemAt(arr, idx) {
        const confirm = await askYesNo(rl, `Delete row ${idx + 1}?`, false);
        if (confirm) arr.splice(idx, 1);
    }

    if (scope === 'A') {
        // Use CREATE as the representative table; mirror to all on each change
        let all = JSON.parse(JSON.stringify(ent.routes.create.query || []));
        const applyAll = () => {
            const cleaned = Array.isArray(all) ? all.filter(q => String(q?.name ?? '').trim()).map(q => {
                const name = String(q.name).trim();
                if ('column' in q && q.column != null && String(q.column).trim() !== '') {
                    return { name, column: String(q.column).trim() };
                }
                return { name, value: String(q?.value ?? '').trim() };
            }) : [];
            all = cleaned;
            ent.routes.create.query = JSON.parse(JSON.stringify(cleaned));
            ent.routes.update.query = JSON.parse(JSON.stringify(cleaned));
            ent.routes.get.query    = JSON.parse(JSON.stringify(cleaned));
        };
        applyAll();

        while (true) {
            printOne('ALL', all);
            const line = (await askWithDefault(rl, 'Command (#,A,D,X): ', '')).trim();
            if (!line) continue;
            const parts = line.split(/\s+/, 2);
            const cmd = parts[0].toUpperCase();

            if (cmd === 'X' || cmd === 'EXIT') break;

            if (cmd === 'A' || cmd === 'ADD') {
                await addItem(all); applyAll(); continue;
            }
            if (cmd === 'D' || cmd === 'DEL') {
                const idx = resolveIndexByToken(all, parts[1]);
                if (idx >= 0) { await deleteItemAt(all, idx); applyAll(); }
                else console.log('Row not found. Use a row number or exact name.');
                continue;
            }

            const idx = resolveIndexByToken(all, line);
            if (idx >= 0) { await editItemAt(all, idx); applyAll(); }
            else console.log('Unknown command. Use <#|name>, A, D <#|name>, or X.');
        }
        applyAll();
        return;
    }

    const k = (scope === 'C') ? 'create' : (scope === 'G') ? 'get' : 'update';
    let arr = ent.routes[k].query;

    while (true) {
        printOne(k.toUpperCase(), arr);
        const line = (await askWithDefault(rl, 'Command (#,A,D,X)', '')).trim();
        if (!line) continue;
        const parts = line.split(/\s+/, 2);
        const cmd = parts[0].toUpperCase();

        if (cmd === 'X' || cmd === 'EXIT') break;

        if (cmd === 'A' || cmd === 'ADD') {
            await addItem(arr);
            arr = arr.filter(q => String(q?.name ?? '').trim());
            ent.routes[k].query = arr;
            continue;
        }
        if (cmd === 'D' || cmd === 'DEL') {
            const idx = resolveIndexByToken(arr, parts[1]);
            if (idx >= 0) { await deleteItemAt(arr, idx); }
            else console.log('Row not found. Use a row number or exact name.');
            arr = arr.filter(q => String(q?.name ?? '').trim());
            ent.routes[k].query = arr;
            continue;
        }

        const idx = resolveIndexByToken(arr, line);
        if (idx >= 0) {
            await editItemAt(arr, idx);
            arr = arr.filter(q => String(q?.name ?? '').trim());
            ent.routes[k].query = arr;
        } else {
            console.log('Unknown command. Use <#|name>, A, D <#|name>, or X.');
        }
    }

    ent.routes[k].query = (ent.routes[k].query || []).filter(q => String(q?.name ?? '').trim());
}


/**
 * tableEditor — interactive schema table editor.
 * Presents current columns, allows add/delete/edit of fields and flags,
 * supports regex generator assistance, and writes changes back to config.
 *
 * @param {any} rl - Readline interface.
 * @param {Object} cfg - Configuration containing schema definitions.
 * @param {string} entityKey - Entity being edited.
 * @returns {Promise<void>}
 */
async function tableEditor(rl, cfg, entityKey) {
    const entity = cfg.entities[entityKey];
    if (!entity.schema) entity.schema = [];

    /**
     * _nameLooks — quick heuristics about a column name's intent.
     * Identifies likely ids, timestamps, emails, phones, and numeric counters.
     *
     * @param {string} name - Column name.
     * @returns {{ kind:string, confidence:number }} Heuristic label and confidence.
     */
    const _nameLooks = (name) => {
        const n = String(name || '').toLowerCase();
        return {
            email: n.includes('email'),
            phone: n.includes('phone') || n.includes('mobile') || n.includes('cell') || n.includes('tel'),
            zip: n.includes('zip') || n.includes('postal'),
            state: n.includes('state'),
        };
    };

    /**
     * _regexSuggestionForName — propose a regex generator for a column name.
     * Uses name heuristics (email/phone/zip/etc.) to suggest a matching pattern.
     *
     * @param {string} name - Column name.
     * @returns {string|null} Suggested regex or null if unknown.
     */
    const _regexSuggestionForName = (name) => {
        const t = _nameLooks(name);
        if (t.email) return '^address@[a-z]{4,10}\\.(com|net|org)$';
        if (t.phone) return '^\\(\\d{3}\\) \\d{3}-\\d{4}$';
        if (t.zip) return '^\\d{5}(-\\d{4})?$';
        if (t.state) return '^(?:A[LKSZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])$';
        return '';
    };

    /**
     * _isDuplicate — check if a schema column has a duplicate value for a given key.
     * Used to prevent conflicting edits within the interactive table.
     *
     * @param {Array<object>} schema - Current schema rows.
     * @param {string} key - Field to compare (e.g., "name").
     * @param {any} value - Proposed value.
     * @param {number} [exceptIndex] - Optional row index to ignore.
     * @returns {boolean} True if a duplicate exists.
     */
    const _isDuplicate = (schema, key, value, exceptIndex) => {
        if (!value) return false;
        const v = String(value).toLowerCase();
        for (let i = 0; i < schema.length; i++) {
            if (i === exceptIndex) continue;
            const other = schema[i] || {};
            const w = String(other[key] || '').toLowerCase();
            if (w && w === v) return true;
        }
        return false;
    };

    /**
     * _regexExamplesForType — return common regex snippets for a given inferred type.
     *
     * @param {string} type - Type category such as "email", "phone", "zip", "id".
     * @returns {Array<string>} Example regex patterns.
     */
    function _regexExamplesForType(type) {
        switch (type) {
            case 'email':
                return [{
                    label: '^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$',
                    sample: 'first.last+tag@company.co'
                }, {
                    label: '^address@[a-z]{4,10}\\.(com|net|org)$',
                    sample: 'address@acme.com'
                }, {label: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', sample: 'any@loose.domain'},];
            case 'phone':
                return [{
                    label: '^\\(\\d{3}\\) \\d{3}-\\d{4}$',
                    sample: '(214) 555-7890'
                }, {label: '^\\d{3}-\\d{3}-\\d{4}$', sample: '214-555-7890'}, {
                    label: '^\\+1 \\d{3} \\d{3} \\d{4}$',
                    sample: '+1 214 555 7890'
                }, {label: '^\\d{10}$', sample: '2145557890'},];
            case 'zip':
                return [{label: '^\\d{5}$', sample: '75001'}, {label: '^\\d{5}(-\\d{4})?$', sample: '75001-1234'},];
            case 'state':
                return [{
                    label: '^(?:A[LKSZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])$',
                    sample: 'TX, CA, NY only'
                },];
            default:
                return [];
        }
    }

    /**
     * _inferTypeByName — guess a semantic type from a column name.
     * Helps prefill generator patterns and validation hints in the editor.
     *
     * @param {string} name - Column name.
     * @returns {string|null} Inferred type label or null.
     */
    function _inferTypeByName(name) {
        const t = _nameLooks(name);
        if (t.email) return 'email';
        if (t.phone) return 'phone';
        if (t.zip) return 'zip';
        if (t.state) return 'state';
        return null;
    }

    /**
     * _pickRegexPattern — interactive picker for a regex generator pattern.
     * Presents suggestions, accepts custom input, and returns the chosen pattern.
     *
     * @param {any} rl - Readline interface for prompts.
     * @param {string} colName - Column being edited.
     * @param {string} entityKey - Entity identifier for context.
     * @param {string|null} inferredType - Optional inferred type label.
     * @param {string|null} currentPattern - Existing pattern to prefill.
     * @returns {Promise<string|null>} Selected pattern or null to skip.
     */
    async function _pickRegexPattern(rl, colName, entityKey, inferredType, currentPattern) {
        const items = _regexExamplesForType(inferredType || '');
        if (!items.length) {
            console.log(`
Regex help examples:
  • Email: ^[\\w._%+-]+@[A-Za-z0-9.-]+\\.(com|net|org|edu|gov)$
      e.g. address@example.com or user+tag@school.edu

  • Phone: ^(\\+1\\s?)?(\\(?\\d{3}\\)?[-.\\s]?)\\d{3}[-.\\s]?\\d{4}$
      e.g. (214) 555-7890 or 214-555-7890 or +1 214 555 7890

  • ZIP: ^\\d{5}(-\\d{4})?$
      e.g. 75001 or 75001-1234

  • State: ^(A[KLRZ]|C[AOT]|D[CE]|F[LM]|G[AU]|H[I]|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AWR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])$
      e.g. TX, CA, NY

  • Alpha (1–10 letters): ^[A-Za-z]{1,10}$
      e.g. Rich or TestValue

  • Alphanumeric (1–10 chars): ^[A-Za-z0-9]{1,10}$
      e.g. C2User01 or Test1

  • Extension (3–5 digits): ^\\d{3,5}$
      e.g. 123 or 4567
`);

            const retry = await askInlinePrefilled(rl, `(${colName}) GenRegex (blank = none): `, currentPattern || '');
            return retry || '';
        }

        console.log("");
        console.log('Column [' + colName + '] GenRegex help — pick a pattern or (S)kip:');
        items.forEach((it, i) => {
            console.log(`  ${i + 1}) ${it.label.padEnd(48, ' ')} → "${it.sample}"`);
        });
        console.log('  E) Enter a custom pattern');
        console.log('  S) Skip (no change)');
        const choice = (await askInlinePrefilled(rl, 'Choice:', '')).trim().toUpperCase();

        if (choice === '' || choice === 'S') return currentPattern || '';
        if (choice === 'E') {
            const custom = await askInlinePrefilled(rl, `(${entityKey}) Enter custom regex: `, currentPattern || '');
            return custom || '';
        }
        if (/^\d+$/.test(choice)) {
            const idx = parseInt(choice, 10) - 1;
            if (idx >= 0 && idx < items.length) return items[idx].label;
        }

        return currentPattern || '';
    }

    /**
     * runCreateRegexAssist — walkthrough to help author a regex for a column.
     * Guides discovery (infer type → suggest patterns → preview) and returns
     * the accepted pattern back to the table editor.
     *
     * @param {any} rl - Readline interface.
     * @param {object} entity - Entity owning the schema.
     * @returns {Promise<void>}
     */
    async function runCreateRegexAssist(rl, entity) {
        if (!entity || !Array.isArray(entity.schema)) return;
        for (const col of entity.schema) {
            if (!col || !col.name) continue;
            if (col.generatePatternRegex) continue;
            const type = _inferTypeByName(col.name);
            if (!type) continue;

            col.generatePatternRegex = await _pickRegexPattern(rl, col.name, entityKey, type, '');
        }
        console.log('CREATEREGEX pass complete.');
    }


    while (true) {
        printPreviewTable(cfg, entityKey);

        console.log("");
        console.log('Commands:');
        console.log(`  <row# | columnName>     (starts interactive edit for that row) — (${entityKey})`);
        console.log('  [A]DD                   (append a new blank row, then prompt for its values)');
        console.log('  [D]EL <#|columnName>    (delete that row; asks for confirmation, default = N)');
        console.log('  [B]ACKFILL              (auto-copy from more-populated side; ask only on conflicts)');
        console.log('  CREATE[R]EGEX           (propose GenRegex for email/phone/zip/state columns)');
        console.log('  X                       (eXit Table Editor)');
        console.log("");

        const line = (await askWithDefault(rl, 'Command (#,A,D,B,R,X)', 'X')).trim();
        if (!line) continue;
        if (/^(q|quit|x|exit)$/i.test(line)) return;

        if (/^(b|backfill)$/i.test(line)) {
            const {filledCreate, filledUpdate} = await runBackfill(entity);
            console.log(`Backfill complete. createApiField filled: ${filledCreate}, updateApiField filled: ${filledUpdate}.`);
            continue;
        }
        if (/^(r|createregex)$/i.test(line)) {
            await runCreateRegexAssist(rl, entity);
            continue;
        }
        if (/^(a|add)$/i.test(line)) {
            const newCol = {
                name: '',
                type: 'NVARCHAR',
                length: null,
                precision: null,
                scale: null,
                isPk: false,
                immutable: false,
                serverGeneratedOnCreate: false,
                required: false,
                createApiField: '',
                updateApiField: ''
            };
            entity.schema.push(newCol);
            await editRowInteractive(rl, newCol, entityKey);
            continue;
        }
        const delMatch = line.match(/^(d|del)\s+(.+)$/i);
        if (delMatch) {
            const target = line.replace(/^(?:d|del)\s+/i, '').trim();
            let idx = -1;
            if (/^\d+$/.test(target)) {
                const n = Math.max(0, parseInt(target, 10) - 1);
                if (n >= 0 && n < entity.schema.length) idx = n;
            } else {
                const want = target.toLowerCase();
                idx = entity.schema.findIndex(c => String(c.name || '').toLowerCase() === want);
            }
            if (idx < 0) {
                console.log('Row not found.');
                continue;
            }
            const colName = entity.schema[idx]?.name || `#${idx + 1}`;
            const ok = await askYesNo(rl, `Delete row ${idx + 1} (“${colName}”)?`, false);
            if (ok) {
                entity.schema.splice(idx, 1);
                console.log('Row deleted.');
            } else {
                console.log('Canceled.');
            }
            continue;
        }
        if (/^\d+$/.test(line)) {
            const idx = Math.max(0, parseInt(line, 10) - 1);
            if (idx >= 0 && idx < entity.schema.length) {
                await editRowInteractive(rl, entity.schema[idx], entityKey);
                continue;
            }
            console.log('Invalid row number.');
            continue;
        }
        const want = line.toLowerCase();
        const idx = entity.schema.findIndex(c => String(c.name || '').toLowerCase() === want);
        if (idx >= 0) {
            await editRowInteractive(rl, entity.schema[idx], entityKey);
            continue;
        }
        console.log('Unknown input. Type a row number, a column name, A, D <#|name>, B, R, Q, ADD, DEL <#|name>, BACKFILL, CREATEREGEX, or Q.');
    }

    /**
     * editRowInteractive — interactive editor for a single schema row.
     * Lets the user edit name/type/length/flags/mappings and optionally attach
     * a generator regex, validating input before applying.
     *
     * @param {any} rl - Readline interface.
     * @param {object} col - Schema row object to modify.
     * @param {string} entityKey - Entity context for display.
     * @returns {Promise<void>}
     */
    async function editRowInteractive(rl, col, entityKey) {
        const idxSelf = entity.schema.indexOf(col);

        while (true) {
            const next = await askInlinePrefilled(rl, `(${entityKey}) Column name: `, col.name || '');
            if (next && _isDuplicate(entity.schema, 'name', next, idxSelf)) {
                console.log('⚠️  A column with that name already exists. Please enter a unique value.');
                continue;
            }
            col.name = next || '';
            break;
        }

        if (!col.generatePatternRegex) {
            const suggested = _regexSuggestionForName(col.name);
            if (suggested) col.generatePatternRegex = suggested;
        }

        col.type = await askInlinePrefilled(rl, `(${entityKey}) SQL type: `, col.type || 'NVARCHAR');

        const lenVal = await askInlinePrefilled(rl, `(${entityKey}) Length (blank = none): `, col.length == null ? '' : String(col.length));
        col.length = (lenVal === '') ? null : lenVal;

        const pkVal = await askInlinePrefilled(rl, `(${entityKey}) Is PK (Y/N): `, col.isPk ? 'Y' : 'N');
        col.isPk = /^y(es)?$/i.test(pkVal);
        if (col.isPk) col.immutable = true;

        const reqVal = await askInlinePrefilled(rl, `(${entityKey}) Required (Y/N): `, col.required ? 'Y' : 'N');
        col.required = /^y(es)?$/i.test(reqVal);

        const immVal = await askInlinePrefilled(rl, `(${entityKey}) Immutable (Y/N): `, col.immutable ? 'Y' : 'N');
        col.immutable = /^y(es)?$/i.test(immVal);

        const genVal = await askInlinePrefilled(rl, `(${entityKey}) ServerGeneratedOnCreate (Y/N): `, col.serverGeneratedOnCreate ? 'Y' : 'N');
        col.serverGeneratedOnCreate = /^y(es)?$/i.test(genVal);

        while (true) {
            const caf = await askInlinePrefilled(rl, `(${entityKey}) createApiField (blank = none): `, col.createApiField || '');
            const v = String(caf || '').trim();
            if (v && _isDuplicate(entity.schema, 'createApiField', v, idxSelf)) {
                console.log('⚠️  Another row already uses that createApiField. Please enter a unique value.');
                continue;
            }
            col.createApiField = v;
            break;
        }
        while (true) {
            const uaf = await askInlinePrefilled(rl, `(${entityKey}) updateApiField (blank = none): `, col.updateApiField || '');
            const v = String(uaf || '').trim();
            if (v && _isDuplicate(entity.schema, 'updateApiField', v, idxSelf)) {
                console.log('⚠️  Another row already uses that updateApiField. Please enter a unique value.');
                continue;
            }
            col.updateApiField = v;
            break;
        }

        const currentStatic = (col.staticValue == null ? '' : String(col.staticValue));
        const sv = await askInlinePrefilled(rl, `(${entityKey}) Static value (blank = remove): `, currentStatic);
        if (sv === '' || sv == null) {
            if ('staticValue' in col) delete col.staticValue;
        } else {
            col.staticValue = sv;
        }

        const inferredType = _inferTypeByName(col.name);
        const defaultRegex = col.generatePatternRegex || '';
        const gr = await askInlinePrefilled(rl, `(${entityKey}) GenRegex (blank = none; type H for help): `, defaultRegex);
        if (/^[Hh]$/.test(gr)) {
            const picked = await _pickRegexPattern(rl, col.name, entityKey, inferredType, defaultRegex);
            if (picked === '') delete col.generatePatternRegex; else col.generatePatternRegex = picked;
        } else {
            if (gr === '') delete col.generatePatternRegex; else col.generatePatternRegex = gr;
        }
    }
}

/**
 * runBackfill — copy missing mappings between create and update sides.
 * Scans both schema sides, backfills unmapped fields, and reports how many
 * entries were filled automatically.
 *
 * @param {Object} entity - Entity object containing schema to update.
 * @returns {Promise<{filledCreate: number, filledUpdate: number}>}
 */
async function runBackfill(entity) {
    const cols = entity.schema || [];
    const countCreatePopulated = cols.reduce((n, c) => n + (!!(c.createApiField || '').trim()), 0);
    const countUpdatePopulated = cols.reduce((n, c) => n + (!!(c.updateApiField || '').trim()), 0);
    const sourceSide = (countCreatePopulated >= countUpdatePopulated) ? 'create' : 'update';

    let filledCreate = 0, filledUpdate = 0;
    for (const c of cols) {
        const src = (sourceSide === 'create') ? c.createApiField : c.updateApiField;
        if (sourceSide === 'create') {
            if (!c.updateApiField && src) {
                c.updateApiField = src;
                filledUpdate++;
            }
        } else {
            if (!c.createApiField && src) {
                c.createApiField = src;
                filledCreate++;
            }
        }
    }
    return {filledCreate, filledUpdate};
}

/**
 * printPreviewTable — render a compact CLI table of the entity schema.
 * Displays PK/immutable/required flags, mapping columns for create/update,
 * and any static values for quick inspection.
 *
 * @param {Object} cfg - Full configuration object.
 * @param {string} entityKey - Entity key to preview.
 * @returns {void}
 */
function printPreviewTable(cfg, entityKey) {
    const e = cfg.entities[entityKey];
    const headers = ['#', 'Column', 'Type', 'Len', 'PK', 'createApiField', 'updateApiField', 'Req', 'Immutable', 'SrvGenOnCreate', 'Static', 'GenRegex'];
    const rows = (e.schema || []).map((c, idx) => [String(idx + 1), c.name || '', c.type || '', c.length == null ? '' : String(c.length), c.isPk ? 'PK' : '', c.createApiField || '', c.updateApiField || '', c.required ? 'Y' : '', c.immutable ? 'Y' : '', c.serverGeneratedOnCreate ? 'Y' : '', c.staticValue == null ? '' : String(c.staticValue), c.generatePatternRegex ? (String(c.generatePatternRegex).length > 22 ? String(c.generatePatternRegex).slice(0, 22) + '...' : String(c.generatePatternRegex)) : '']);
    printTable(headers, rows);
}

/**
 * applyAnalysis — merge HAR analysis results into an entity.
 * Updates payload wrappers, fills missing field mappings, and re-infers
 * server-generated flags for the specified side (create/update).
 *
 * @param {Object} entity - Entity being updated.
 * @param {Object} analysis - Result from analyzeSingleEntry.
 * @param {string} side - "create" or "update".
 * @returns {void}
 */
function applyAnalysis(entity, analysis, side) {
    entity.payload = entity.payload || {};
    entity.payload[side] = entity.payload[side] || {jsonPayloadWrapper: null, requiredKeys: []};

    if (analysis.wrapper) entity.payload[side].jsonPayloadWrapper = analysis.wrapper;

    entity.payload[side].requiredKeys = [];

    entity.routes = entity.routes || { create: { headers: [] }, update: { headers: [] } };
    entity.routes[side] = entity.routes[side] || { headers: [] };

    if (analysis.headers && analysis.headers.length) {
        entity.routes[side].headers = sanitizeHeaders(analysis.headers);
    }

    const schema = entity.schema || [];
    fillMappingsFromKeysDeep(schema, analysis, side);

    inferServerGeneratedFields(entity, analysis);
}
