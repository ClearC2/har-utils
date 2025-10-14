#!/usr/bin/env node
/**
 * @file build-har-config.js
 * @summary Interactive wizard for defining entity→API mappings (C mode).
 * @description Guides entity selection, schema discovery/merge from SQL, HAR-based route/wrapper learning,
 * and a review loop for TABLE/HEADERS/SUMMARY before saving the configuration.
 */


const fs = require('fs');
const { URL } = require('url');

const {
    CONFIG_PATH,


    rlCreate,  askWithDefault, askYesNo, askInlinePrefilled,


    loadJsonc, saveJsonc,


    listEntitiesCaseInsensitive, canonicalEntityKey,


    collectKeysDeep, decode, formToObj, tryExtractJson,

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



/** Render an ASCII table with widths sized to headers and rows. */
function printTable(headers, rows) {
    const widths = headers.map((h, i) =>
        Math.max(String(h).length, ...rows.map(r => (String(r[i] ?? '')).length))
    );
    const pad = (s, w) => (String(s)).padEnd(w, ' ');
    const lineTop = '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
    const sep  = '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
    const end  = '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';
    console.log('');
    console.log(lineTop);
    console.log('│ ' + headers.map((h, i) => pad(h, widths[i])).join(' │ ') + ' │');
    console.log(sep);
    for (const r of rows) console.log('│ ' + r.map((c, i) => pad(c, widths[i])).join(' │ ') + ' │');
    console.log(end);
}


/** Remove null/undefined static values from schema rows to avoid saving meaningless entries. */
function cleanNullStatics(cfg) {
    if (!cfg || !cfg.entities) return cfg;
    for (const ent of Object.values(cfg.entities)) {
        if (!ent || !Array.isArray(ent.schema)) continue;
        for (const col of ent.schema) {
            if (!col) continue;
            if (Object.prototype.hasOwnProperty.call(col, 'staticValue') &&
                (col.staticValue === null || col.staticValue === undefined)) {
                delete col.staticValue;
            }
        }
    }
    return cfg;
}
/** Persist configuration after applying cleanNullStatics. */
function saveConfigClean(cfg) {
    cleanNullStatics(cfg);
    saveJsonc(CONFIG_PATH, cfg, DEFAULT_HEADER);
}


/** Program entry: prompts, entity pick, SQL/HAR stages, then the review loop. */
(async function main() {
    const rl = rlCreate();
    try {

        console.log('\nThis utility creates a config file to be used by the .har generator.');
        console.log('It learns from a SQL CREATE TABLE example, and an existing .har file captured');
        console.log('in your browser’s network tool that performs a create and an update API call (xhr)');
        console.log('for the entity you are trying to define.\n');

        let cfg = loadJsonc(CONFIG_PATH) || {};
        cfg = cleanNullStatics(cfg);
        cfg.sourcesLastUsed = cfg.sourcesLastUsed || { sqlPath: '', harPath: '' };


        const { key: entityKey, isNew } = await pickEntityWithNewFlag(rl, cfg);
        const e = upsertEntity(cfg, entityKey);
        console.log('');

        if (!isNew) {
            const mdChoice = await askWithDefault(
                rl,
                `Do you want to (M)odify or (D)elete the entity "${entityKey}"? (M/D) [M]: `,
                'M'
            );

            if (/^d/i.test(mdChoice || '')) {
                const confirm = await askInlinePrefilled(
                    rl,
                    `Type DELETE to confirm deletion of ${entityKey}: `,
                    ''
                );
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


        const hadSchema =
            Array.isArray(e.schema) &&
            e.schema.some(col => col && typeof col === 'object' && Object.keys(col).length > 0);

        if (!hadSchema) {
            console.log(`\nNo schema[] for entity ${entityKey}. SQL CREATE TABLE is required.`);
            await requireSql(rl, cfg, entityKey);
        } else {

            const doMerge = await askYesNo(
                rl,
                `Upload a new SQL CREATE TABLE to update stored schema for ${entityKey}?`,
                false
            );
            if (doMerge) {
                await optionalSqlMerge(rl, cfg, entityKey);
            } else {
                console.log(`Using existing schema for ${entityKey}. (Use TABLE later to edit/merge.)`);

            }
        }


        {
            const ent = cfg.entities[entityKey];
            const hasHarish =
                !!(ent?.routes?.host) ||
                !!(ent?.routes?.create?.path) ||
                !!(ent?.routes?.update?.path) ||
                !!(ent?.payload?.create?.jsonPayloadWrapper) ||
                !!(ent?.payload?.update?.jsonPayloadWrapper);

            if (!hasHarish) {
                console.log(`\nNo HAR-derived info for ${entityKey}. A HAR file is required to learn routes and payload shape.`);
                await harFlow(rl, cfg, entityKey);
            } else {
                console.log('');
                const wantHar = await askYesNo(
                    rl,
                    `Supply a sample HAR with API calls that create and update ${entityKey}?`,
                    false
                );
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


/** Print preview + summary and route to TABLE/HEADERS/SUMMARY editors or save+exit. */
async function reviewLoop(rl, cfg, entityKey) {
    while (true) {
        printPreviewTable(cfg, entityKey);
        printHeaders(cfg.entities[entityKey], entityKey);
        printSummary(cfg.entities[entityKey], entityKey);
        console.log('\nDo you want to edit the TABLE (T), HEADERS (H), SUMMARY (S), or Q to save and exit .');
        const cmd = (await askWithDefault(rl, '> ', '')).trim().toUpperCase();
        if (cmd === 'Q') {
            saveConfigClean(cfg);
            console.log('Configuration saved.');
            rl.close();
            process.exit(0);
        } else if (cmd === 'TABLE' || cmd === 'T') {
            await tableEditor(rl, cfg, entityKey);
            console.log('');
        } else if (cmd === 'HEADERS' || cmd === 'HEADER' || cmd === 'H') {
            await headersEditor(rl, cfg, entityKey);
            console.log('');
        } else if (cmd === 'SUMMARY' || cmd === 'S') {
            await summaryPromptsOnce(rl, cfg.entities[entityKey], entityKey);
            console.log('');
        } else {
            console.log('Unknown command. Type T, H, S, or Q.');
        }
    }
}


/** Ensure entity exists, normalize structure, migrate legacy wrapper fields, ensure headers arrays. */
function upsertEntity(cfg, key) {
    cfg.entities = cfg.entities || {};
    if (!cfg.entities[key]) {
        cfg.entities[key] = {
            routes: { host: null, create: { path: null, method: null, params: [], headers: [] }, update: { path: null, method: null, params: [], headers: [] } },
            payload: {
                create: { jsonPayloadWrapper: null, requiredKeys: [] },
                update: { jsonPayloadWrapper: null, requiredKeys: [] }
            },
            schema: [],
            sources: { sqlPath: '', harPath: '' }
        };
    } else {

        const p = cfg.entities[key].payload || (cfg.entities[key].payload = {});
        for (const side of ['create','update']) {
            const obj = p[side] || (p[side] = {});
            if ('wrapper' in obj && !('jsonPayloadWrapper' in obj)) {
                obj.jsonPayloadWrapper = obj.wrapper || null;
                delete obj.wrapper;
            }
            if ('shape' in obj) delete obj.shape;
            if (!('requiredKeys' in obj)) obj.requiredKeys = [];
        }


        cfg.entities[key].routes = cfg.entities[key].routes || { create: {}, update: {} };
        cfg.entities[key].routes.create = cfg.entities[key].routes.create || {};
        cfg.entities[key].routes.update = cfg.entities[key].routes.update || {};
        if (!("headers" in cfg.entities[key].routes.create)) cfg.entities[key].routes.create.headers = [];
        if (!("headers" in cfg.entities[key].routes.update)) cfg.entities[key].routes.update.headers = [];
        cfg.entities[key].sources = cfg.entities[key].sources || { sqlPath: '', harPath: '' };

        cfg.entities[key].routes = cfg.entities[key].routes || { create: {}, update: {} };
        cfg.entities[key].routes.create = cfg.entities[key].routes.create || {};
        cfg.entities[key].routes.update = cfg.entities[key].routes.update || {};
        if (!("headers" in cfg.entities[key].routes.create)) cfg.entities[key].routes.create.headers = [];
        if (!("headers" in cfg.entities[key].routes.update)) cfg.entities[key].routes.update.headers = [];
    }
    return cfg.entities[key];
}

/** Show list of entities; accept selection by number or name; support new entity and quit. */
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

        const prompt = items.length
            ? 'Existing or New Entity name/number (or Q to quit): '
            : 'Enter new entity name (or Q to quit): ';


        const input = (await askWithDefault(rl, prompt, items[0] || '')).trim();

        if (!input) {
            if (items.length) return { key: items[0], isNew: false };
            console.log('Please enter a name, a number, or Q to quit.');
            continue;
        }

        if (/^(q|quit)$/i.test(input)) {
            console.log('Canceled.');
            process.exit(0);
        }

        if (/^\d+$/.test(input) && items.length) {
            const n = parseInt(input, 10);
            if (n >= 1 && n <= items.length) return { key: items[n - 1], isNew: false };
            console.log('Invalid selection.');
            continue;
        }

        const canon = canonicalEntityKey(cfg, input);
        if (canon) return { key: canon, isNew: false };

        const ok = await askYesNo(rl, `Create new entity "${input}"?`, true);
        if (ok) return { key: input, isNew: true };
    }
}


/** Prompt repeatedly until an existing file path is provided; input prefilled with a suggestion. */
async function askExistingPathPrefill(rl, label, prefill) {
    const lbl = label.endsWith(':') ? label : `${label}:`;
    while (true) {
        const p = await askInlinePrefilled(rl, lbl, prefill || '');
        if (p && fs.existsSync(p)) return p;
        console.log(p ? `File not found: ${p}` : 'Please enter a file path.');
    }
}


/** Require initial SQL CREATE TABLE for schema discovery when schema is missing. */
async function requireSql(rl, cfg, entityKey) {
    const e = cfg.entities[entityKey];
    while (true) {
        const prefill = (e.sources?.sqlPath || cfg.sourcesLastUsed?.sqlPath || '');
        const p = await askExistingPathPrefill(rl, `(${entityKey}) Path to SQL CREATE TABLE script`, prefill);
        const sql = fs.readFileSync(p, 'utf8');
        const parsed = tryParseSql(sql);
        if (parsed && parsed.columns.length) {
            rememberSourcePaths(cfg, entityKey, { sqlPath: p });
            mergeSchema(cfg, entityKey, parsed, { mode: 'require' });
            console.log(`\nHere's the Schema I found for ${entityKey}:`);
            printPreviewTable(cfg, entityKey);
            return;
        }
        console.log('Could not parse any columns. Please provide a valid CREATE TABLE.');
    }
}
/** Merge a new SQL CREATE TABLE into existing schema and report structural changes. */
async function optionalSqlMerge(rl, cfg, entityKey) {
    const e = cfg.entities[entityKey];
    const prefill = (e.sources?.sqlPath || cfg.sourcesLastUsed?.sqlPath || '');
    const p = await askExistingPathPrefill(rl, `(${entityKey}) Path to SQL CREATE TABLE script`, prefill);
    const sql = fs.readFileSync(p, 'utf8');
    const parsed = tryParseSql(sql);
    if (parsed && parsed.columns.length) {
        rememberSourcePaths(cfg, entityKey, { sqlPath: p });
        mergeSchema(cfg, entityKey, parsed, { mode: 'merge' });
        console.log(`\nHere's the Schema I found for ${entityKey}:`);
        printPreviewTable(cfg, entityKey);
    } else {
        console.log('⚠️  SQL parse failed; keeping existing schema untouched.');
    }
}
/** Attempt to parse SQL; on error return null for a gentle retry loop. */
function tryParseSql(sql) { try { return parseSqlCreate(sql); } catch(e){ console.log('SQL parse error:', e?.message||e); return null; } }


/** Parse CREATE TABLE: extract columns, sizes/precision, and primary keys (inline/table-level). */
function parseSqlCreate(sql) {
    const input = String(sql).replace(/^\uFEFF/, '').replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--.*$/gm,' ').replace(/\r\n/g,'\n');
    const ct = input.match(/create\s+table\s+(\[.*?]|".*?"|`.*?`|[\w.]+)/i);
    if (!ct) throw new Error('CREATE TABLE block not found.');
    const afterCt = input.slice(ct.index + ct[0].length);
    const firstParenRel = afterCt.indexOf('(');
    if (firstParenRel < 0) throw new Error('Opening "(" for CREATE TABLE not found.');
    const bodyStart = ct.index + ct[0].length + firstParenRel + 1;

    let i = bodyStart, depth = 1, inSQ=false, inDQ=false, inBQ=false, inBr=false;
    while (i < input.length && depth > 0) {
        const ch = input[i], prev = input[i - 1];
        if (!inSQ && !inDQ && !inBQ) { if (ch === '[') inBr = true; else if (ch === ']') inBr = false; }
        if (!inBr) {
            if (!inDQ && !inBQ && ch === "'" && prev !== '\\') inSQ = !inSQ;
            else if (!inSQ && !inBQ && ch === '"' && prev !== '\\') inDQ = !inDQ;
            else if (!inSQ && !inDQ && ch === '`') inBQ = !inBQ;
        }
        if (!inSQ && !inDQ && !inBQ && !inBr) { if (ch==='(') depth++; else if (ch===')') depth--; }
        i++;
    }
    if (depth !== 0) throw new Error('Could not find matching ")" of CREATE TABLE body.');
    const body = input.slice(bodyStart, i - 1).trim();

    const clauses = [];
    {
        let buf = '', d=0, sQ=false, dQ=false, btQ=false, bQ=false;
        for (let k=0;k<body.length;k++) {
            const ch = body[k], prev = body[k-1];
            if (!sQ && !dQ && !btQ) { if (ch==='[') bQ=true; else if (ch===']') bQ=false; }
            if (!bQ) {
                if (!dQ && !btQ && ch==="'" && prev!=='\\') sQ=!sQ;
                else if (!sQ && !btQ && ch === '"' && prev!=='\\') dQ=!dQ;
                else if (!sQ && !dQ && ch === '`') btQ=!btQ;
            }
            if (!sQ && !dQ && !btQ && !bQ) { if (ch==='(') d++; else if (ch===')') d = Math.max(0, d-1); }
            if (ch===',' && d===0 && !sQ && !dQ && !btQ && !bQ) { if (buf.trim()) clauses.push(buf.trim()); buf=''; continue; }
            buf += ch;
        }
        if (buf.trim()) clauses.push(buf.trim());
    }

    const cols = []; const tablePk = [];
    const stripBrackets = s => s.replace(/^\[|]$/g,'');
    const stripQuotes = s => s.replace(/^["'`]|["'`]$/g,'');
    for (let raw of clauses) {
        const line = raw.trim();
        const pkMatch = line.match(/^(?:constraint\s+\S+\s+)?primary\s+key\b[\s\S]*?\(([^)]+)\)/i);
        if (pkMatch) {
            pkMatch[1].split(',').forEach(chunk=>{
                let col = chunk.trim().replace(/\bASC\b|\bDESC\b/ig, '').replace(/\s+/g, ' ').trim();
                const bracketed = col.match(/\[([^\]]+)]/);
                if (bracketed) col = bracketed[1];
                else col = stripQuotes(col.split(/\s+/)[0]);
                if (col) tablePk.push(col);
            }); continue;
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
            if (/^\d+$/i.test(size)) length = parseInt(size,10);
            else if (/^\d+\s*,\s*\d+$/i.test(size)) { const [p,s]=size.split(',').map(x=>parseInt(x,10)); precision=p; scale=s; length=`${p},${s}`; }
            else if (/^max$/i.test(size)) length = 'MAX';
        }
        const inlinePk = /\bprimary\s+key\b/i.test(line);
        cols.push({ name, type, length, precision, scale, inlinePk });
    }

    const primaryKeys = Array.from(new Set([
        ...cols.filter(c=>c.inlinePk).map(c=>c.name),
        ...tablePk
    ]));
    return { columns: cols, primaryKeys };
}
/** Merge parsed columns with existing schema; set PK/immutable flags and sort (PKs first). */
function mergeSchema(cfg, entityKey, parsed, { mode }) {
    const e = cfg.entities[entityKey];
    const prev = Array.isArray(e.schema) ? e.schema : [];
    const pkSet = new Set(parsed.primaryKeys.map(x=>x.toLowerCase()));
    const prevMap = new Map(prev.map(col => [col.name.toLowerCase(), col]));
    const merged = [];
    const added = []; const updated = [];

    for (const c of parsed.columns) {
        const key = c.name.toLowerCase();
        const existed = prevMap.get(key);
        if (!existed) {

            merged.push({
                name: c.name, type: c.type,
                length: c.length ?? (c.precision!=null ? `${c.precision}${c.scale!=null?','+c.scale:''}` : null),
                precision: c.precision ?? null, scale: c.scale ?? null,
                isPk: pkSet.has(key), immutable: pkSet.has(key),
                createApiField: "", updateApiField: "",
                serverGeneratedOnCreate: false
            });
            added.push(c.name);
        } else {
            const wasPk = !!existed.isPk; const nowPk = pkSet.has(key);
            const row = {
                ...existed,
                type: c.type,
                length: (c.length ?? (c.precision!=null ? `${c.precision}${c.scale!=null?','+c.scale:''}` : null)),
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

    const newSet = new Set(parsed.columns.map(c=>c.name.toLowerCase()));
    const dropped = prev.filter(col => !newSet.has(col.name.toLowerCase())).map(c=>c.name);

    merged.sort((a,b)=> (!!a.isPk !== !!b.isPk) ? (a.isPk?-1:1) : String(a.name).localeCompare(String(b.name)) );
    e.schema = merged;

    if (mode === 'merge') {
        console.log('\nSchema merge summary');
        if (added.length)  console.log('  + Added columns:', added.join(', '));
        if (updated.length)console.log('  ~ Updated structure:', updated.join(', '));
        if (dropped.length) console.log('  - Dropped (missing in new SQL):', dropped.join(', '));
        if (!added.length && !updated.length && !dropped.length) console.log('  (no structural changes)');
    }
}


/** Gather host, paths, methods, slug-to-column mapping, and JSON payload wrappers for both sides. */
async function summaryPromptsOnce(rl, e, entityKey) {
    const routes = e.routes || (e.routes = { host: null, create:{}, update:{} });
    routes.create = routes.create || { path: null, method: null, params: [] };
    routes.update = routes.update || { path: null, method: null, params: [] };
    e.payload = e.payload || { create: {}, update: {} };
    e.payload.create = e.payload.create || { jsonPayloadWrapper: null, requiredKeys: [] };
    e.payload.update = e.payload.update || { jsonPayloadWrapper: null, requiredKeys: [] };

    console.log(`\nPlease edit or confirm for entity ${entityKey}:\n`);

    routes.host = await askInlinePrefilled(rl, `(${entityKey}) Host:`, routes.host || (e.routes.host || ''));

    routes.create.method = (await askInlinePrefilled(
        rl, `(${entityKey}) CREATE method:`, (routes.create.method || 'POST').toUpperCase()
    )).toUpperCase();
    routes.create.path = await askInlinePrefilled(
        rl, `(${entityKey}) CREATE path:`, routes.create.path || '/api/<entity>'
    );

    routes.update.method = (await askInlinePrefilled(
        rl, `(${entityKey}) UPDATE method:`, (routes.update.method || 'POST').toUpperCase()
    )).toUpperCase();
    routes.update.path = await askInlinePrefilled(
        rl, `(${entityKey}) UPDATE path:`, routes.update.path || `/api/${entityKey.toLowerCase()}/id/:id`
    );


    const currentIdParam = (routes.update.params && routes.update.params[0]) || { name: 'id', column: '' };
    let defaultIdColumn = currentIdParam.column || bestPkOrBlank(e);
    if (!defaultIdColumn) {
        defaultIdColumn = await promptForPkColumn(rl, e.schema, entityKey);
    }
    const idCol = await askInlinePrefilled(rl, `(${entityKey}) UPDATE param "id" column:`, defaultIdColumn || '');
    routes.update.params = [{ name: 'id', column: idCol }];

    const cwrap = await askInlinePrefilled(
        rl, `(${entityKey}) CREATE JSON payload wrapper (blank = none):`, e.payload.create.jsonPayloadWrapper || ''
    );
    e.payload.create.jsonPayloadWrapper = cwrap || null;

    const uwrap = await askInlinePrefilled(
        rl, `(${entityKey}) UPDATE JSON payload wrapper (blank = none):`, e.payload.update.jsonPayloadWrapper || ''
    );
    e.payload.update.jsonPayloadWrapper = uwrap || null;

    console.log('');
}
/** Return first schema column marked PK, otherwise empty string. */
function bestPkOrBlank(entity) {
    const schema = entity?.schema || [];
    const pk = schema.find(c => c.isPk);
    return pk ? pk.name : '';
}
/** Prompt to select the primary key column from the current schema list. */
async function promptForPkColumn(rl, schema, entityKey) {
    const cols = (schema || []).map(c => c.name);
    if (!cols.length) return '';
    console.log(`\n(${entityKey}) Select a primary key column:`);
    cols.forEach((n, i) => console.log(`  ${String(i+1).padStart(2,' ')}. ${n}`));
    const choice = await askWithDefault(rl, `(${entityKey}) PK column #`, '1');
    const idx = parseInt(choice,10)-1;
    if (Number.isInteger(idx) && idx>=0 && idx<cols.length) return cols[idx];
    return cols[0];
}


/** Create example mapping of path slugs (e.g., :id) to configured params. */
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

function printSummary(e, entityKey) {
    const host = e?.routes?.host || '';
    const cm = (e?.routes?.create?.method || 'POST').toUpperCase();
    const cp = (e?.routes?.create?.path || '');
    const um = (e?.routes?.update?.method || 'POST').toUpperCase();
    const up = (e?.routes?.update?.path || '');
    const uparams = e?.routes?.update?.params || [];

    const cSlugMap = getSlugFillsForPath(cp, e?.routes?.create?.params || []);
    const uSlugMap = getSlugFillsForPath(up, uparams);

    console.log("");
    console.log(`Current SUMMARY for ${entityKey}:`);
    console.log(`  host                              : ${host}`);
    console.log(`  create                            : ${cm} ${cp}`);
    console.log(`  update                            : ${um} ${up}`);
    console.log(`  create JSON payload data wrapper  : ${e?.payload?.create?.jsonPayloadWrapper || '(none)'}`);
    console.log(`  create JSON payload data wrapper  : ${e?.payload?.update?.jsonPayloadWrapper || '(none)'}`);
    const idParam = uparams[0];
    if (idParam) console.log(`  UPDATE param "id" column: ${idParam.column || '(not set)'}`);

    const cSlugs = Object.keys(cSlugMap);
    const uSlugs = Object.keys(uSlugMap);
    if (cSlugs.length || uSlugs.length) {
        console.log('  slug fills :');
        for (const k of cSlugs) console.log(`    (create) :${k} ← ${cSlugMap[k] || '(not set)'}`);
        for (const k of uSlugs) console.log(`    (update) :${k} ← ${uSlugMap[k] || '(not set)'}`);
    }

}

function printHeaders(entity, entityKey) {
    try {

        const ch = sanitizeHeaders(entity?.routes?.create?.headers);
        const uh = sanitizeHeaders(entity?.routes?.update?.headers);


        const sig = (arr) => {
            const pairs = [];
            for (const h of (Array.isArray(arr) ? arr : [])) {
                const name  = String(h?.name || '').trim().toLowerCase();
                const value = String(h?.value ?? '').trim();
                if (!name) continue;
                pairs.push([name, value]);
            }
            pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
            return JSON.stringify(pairs);
        };

        const same = sig(ch) === sig(uh);


        const rows = (arr) => (arr || []).map((h, i) => [String(i + 1), h.name, h.value]);

        if (same) {
            console.log(`\nCurrent HEADERS for ${entityKey} — CREATE & UPDATE (identical)`);
            printTable(['#', 'Name', 'Value'], rows(ch));
        } else {
            console.log(`\nCurrent HEADERS for ${entityKey} — CREATE`);
            printTable(['#', 'Name', 'Value'], rows(ch));
            console.log(`\nCurrent HEADERS for ${entityKey} — UPDATE`);
            printTable(['#', 'Name', 'Value'], rows(uh));
        }
    } catch (e) {
        console.log(`\nCurrent HEADERS for ${entityKey}:`);
        console.log('(unable to render headers table)', e?.message || e);
    }
}


async function harFlow(rl, cfg, entityKey) {
    const ent = cfg.entities[entityKey];


    const prefillHar = (ent.sources?.harPath || cfg.sourcesLastUsed?.harPath || '');
    const harPath = await askExistingPathPrefill(rl, `(${entityKey}) Path to sample HAR file`, prefillHar);
    rememberSourcePaths(cfg, entityKey, { harPath });
    saveConfigClean(cfg);

    const har = loadHar(harPath);


    const entries = harvestEntries(har);
    const summary = harSummary(entries);

    const hostChoice   = await pickHostRequireChoice(rl, summary.hosts, entityKey);
    const createChoice = await pickRouteRequireChoice(rl, summary.routesByMethodPath['POST'] || [], `CREATE (POST) — ${entityKey}`);
    const updateChoice = await pickRouteRequireChoice(rl, summary.routesByMethodPath['POST'] || [], `UPDATE (POST) — ${entityKey}`);


    ent.routes = ent.routes || { host: null, create: {}, update: {} };
    ent.routes.host = hostChoice;
    ent.routes.create = ent.routes.create || {};
    ent.routes.update = ent.routes.update || {};
    ent.routes.create.method = 'POST';
    ent.routes.create.path   = createChoice.path;
    ent.routes.update.method = 'POST';
    ent.routes.update.path   = templateUpdatePathForDisplay(updateChoice.path);


    const oneCreate = findMostRecentMatching(entries, 'POST', createChoice.path);
    const oneUpdate = findMostRecentMatching(entries, 'POST', updateChoice.path);

    if (oneCreate) {
        const analysisC = analyzeSingleEntry(oneCreate, ent, 'create');
        applyAnalysis(ent, analysisC, 'create');
    }
    if (oneUpdate) {
        const analysisU = analyzeSingleEntry(oneUpdate, ent, 'update');
        applyAnalysis(ent, analysisU, 'update');
        suggestUpdateIdParam(ent);
        biasServerGeneratedFromIdParam(ent);
    }



    (function applyHeadersFromSelectedEntries() {

        try {

            ent.routes.create.headers = Array.isArray(ent.routes.create.headers) ? ent.routes.create.headers : [];
            ent.routes.update.headers = Array.isArray(ent.routes.update.headers) ? ent.routes.update.headers : [];

            const createHeaders = sanitizeHeaders(oneCreate?.req?.headers);
            const updateHeaders = sanitizeHeaders(oneUpdate?.req?.headers);

            ent.routes.create.headers = createHeaders;
            ent.routes.update.headers = updateHeaders;
        } catch (e) {

            console.warn('WARN: failed to capture headers from HAR entries:', e?.message || e);
        }
    })();
}


function loadHar(path) {
    try {
        const raw = fs.readFileSync(path, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && obj.log && Array.isArray(obj.log.entries)) return obj;
    } catch (e) {
        throw new Error(`Failed to load HAR: ${e.message || e}`);
    }
}
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
        } catch { path = url; }
        return {
            startedDateTime: e.startedDateTime,
            url, method, path,
            req, res
        };
    });
    return entries.filter(e => e.method && e.path);
}
function harSummary(entries) {
    const hosts = new Set();
    const routesByMethodPath = {};
    for (const e of entries) {
        try {
            const u = new URL(e.url);
            hosts.add(`${u.protocol}//${u.host}`);
        } catch {}
        const key = e.method;
        const arr = routesByMethodPath[key] || (routesByMethodPath[key] = []);
        if (!arr.some(r => r.path === e.path)) arr.push({ path: e.path });
    }
    return { hosts: Array.from(hosts), routesByMethodPath };
}
async function pickHostRequireChoice(rl, hosts, entityKey) {
    if (!hosts.length) throw new Error(`No hosts found in HAR for ${entityKey}.`);
    if (hosts.length === 1) return hosts[0];
    console.log(`\nHosts for ${entityKey}:`);
    hosts.forEach((h, i) => console.log(`  ${String(i+1).padStart(2,' ')}. ${h}`));
    const idx = parseInt(await askWithDefault(rl, `(${entityKey}) Pick host #`, '1'), 10) - 1;
    if (idx < 0 || idx >= hosts.length) return hosts[0];
    return hosts[idx];
}
async function pickRouteRequireChoice(rl, routes, label) {
    if (!routes.length) throw new Error(`No ${label} routes found.`);
    if (routes.length === 1) return routes[0];
    console.log(`\n${label} routes:`);
    routes.forEach((r, i) => console.log(`  ${String(i+1).padStart(2,' ')}. ${r.path}`));
    const idx = parseInt(await askWithDefault(rl, `Pick ${label} route #`, '1'), 10) - 1;
    if (idx < 0 || idx >= routes.length) return routes[0];
    return routes[idx];
}
function findMostRecentMatching(entries, method, path) {
    const m = String(method || '').toUpperCase();
    const arr = entries.filter(e => e.method === m && e.path === path);
    if (!arr.length) return null;
    arr.sort((a, b) => new Date(b.startedDateTime) - new Date(a.startedDateTime));
    return arr[0];
}


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
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        seen.set(name, { name, value });
    }


    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}


function analyzeSingleEntry(entry, entity, side ) {
    const reqJson = parseReqBody(entry.req);
    const resJson = parseResBody(entry.res);


    const wrapperPath = findWrapper(reqJson, { returnPath: true });
    const unwrappedReq = wrapperPath ? unwrapByPath(reqJson, wrapperPath) : reqJson;
    const unwrappedRes = wrapperPath ? unwrapByPath(reqJson, wrapperPath) : resJson;

    const reqLeafs = new Set(collectKeysDeep(unwrappedReq || {}));
    const resLeafs = new Set(collectKeysDeep(unwrappedRes || {}));
    const leafs = (obj) => collectKeysDeep(obj || {});
    const reqDeep = new Set(leafs(unwrappedReq));
    const resDeep = new Set(leafs(unwrappedRes));

    return {
        side,
        wrapper: wrapperPath ? String(wrapperPath).split('.').slice(-1)[0] : null,
        reqKeys: Array.from(reqLeafs),
        resKeys: Array.from(resLeafs),
        reqDeepKeys: Array.from(reqDeep),
        resDeepKeys: Array.from(resDeep),
        exampleReq: unwrappedReq || {},
        exampleRes: resJson || {}
    };

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
function parseResBody(res) {
    const c = res?.content || {};
    if (!c || !c.text) return {};
    const txt = decode(c.text);
    const json = tryExtractJson(txt);
    return json || {};
}

// Returns either the top-level wrapper key or a dotted path if nested.
// If options.returnPath is true, returns a dotted path (e.g., "data.item") when nested is found.
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
    const containers = [
        "data",
        "payload",
        "entity",
        "request",
        "item",
        "record",
        "attributes",
        "wrapper",
        "envelope",
        "result",
        "results",
        "response",
        "body",
    ];

    for (const hint of containers) {
        if (mapNormToKey.has(hint) && isObj(obj[mapNormToKey.get(hint)])) {
            const k = mapNormToKey.get(hint);
            // Recurse one level to allow nested wrapper discovery: { data: { item: {...} } }
            const inner = findWrapper(obj[k], { returnPath: true });
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
            const inner = findWrapper(obj[k], { returnPath: true });
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







function inferServerGeneratedFields(entity, analysis) {
    const reqSet = new Set((analysis.reqDeepKeys || []).map(k => String(k).toLowerCase()));
    const resSet = new Set((analysis.resDeepKeys || []).map(k => String(k).toLowerCase()));

    const getCaseInsensitive = (obj, key) => {
        if (!obj || !key) return undefined;
        if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
        const lower = String(key).toLowerCase();
        for (const k of Object.keys(obj)) {
            if (String(k).toLowerCase() === lower) return obj[k];
        }
        return undefined;
    };
    const isNonEmptyEvidence = (v) => {
        if (v == null) return false;
        if (typeof v === 'string' && v.trim() === '') return false;
        return v !== 0;

    };
    const nameLooksStamped = (lowerName) => {
        return (
            lowerName.startsWith('created') ||
            lowerName.startsWith('modified') ||
            lowerName.startsWith('updated') ||
            lowerName.includes('timestamp') ||
            lowerName === 'rowversion' ||
            lowerName === 'ts' ||
            lowerName === 'ctime' ||
            lowerName === 'mtime'
        );
    };

    for (const col of (entity.schema || [])) {
        const nameLower = String(col.name || '').toLowerCase();

        const mappedCreate = String(col.createApiField || '').toLowerCase();
        const mappedUpdate = String(col.updateApiField || '').toLowerCase();

        const inReqCreate  = mappedCreate && reqSet.has(mappedCreate);
        const inResCreate  = mappedCreate && resSet.has(mappedCreate);
        const inReqUpdate  = mappedUpdate && reqSet.has(mappedUpdate);
        const inResUpdate  = mappedUpdate && resSet.has(mappedUpdate);

        const resCreateVal = getCaseInsensitive(analysis.exampleRes, col.createApiField || '');
        const resUpdateVal = getCaseInsensitive(analysis.exampleRes, col.updateApiField || '');
        const hasNonEmptyResCreate = inResCreate && isNonEmptyEvidence(resCreateVal);
        const hasNonEmptyResUpdate = inResUpdate && isNonEmptyEvidence(resUpdateVal);

        const looksServerGenerated =
            (!inReqCreate && (hasNonEmptyResCreate || nameLooksStamped(nameLower))) ||
            (!inReqUpdate && (hasNonEmptyResUpdate || nameLooksStamped(nameLower))) ||
            nameLooksStamped(nameLower);

        if (looksServerGenerated) {
            col.serverGeneratedOnCreate = true;
            if (!inReqCreate) col.createApiField = '';
            if (!inReqUpdate && inResUpdate) col.updateApiField = '';
            if (nameLooksStamped(nameLower)) col.immutable = true;
        }
    }
}
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

function exactLeafMatch(colNameLower, leafSet) {
    if (!leafSet || !leafSet.size) return '';

    for (const k of colNameLower)
        if (leafSet.has(k))
            return k;
    for (const k of leafSet) {
        if (k === colNameLower) return k;
    }
    return '';
}
function templateUpdatePathForDisplay(path) {
    const segs = String(path || '').split('/').filter(Boolean);
    if (segs.length >= 4 && segs[segs.length-2].toLowerCase() === 'id') {
        segs[segs.length-1] = ':id';
        return '/' + segs.join('/');
    }
    return path || '';
}
function suggestUpdateIdParam(entity) {
    const schema = entity?.schema || [];
    const pkCol = schema.find(c => c.isPk)?.name || '';
    if (!entity.routes) entity.routes = { update: { params: [] } };
    if (!entity.routes.update) entity.routes.update = { params: [] };
    const idParam = (entity.routes.update.params && entity.routes.update.params[0]) || { name: 'id', column: '' };
    const chosen = idParam.column || pkCol || '';
    entity.routes.update.params = [{ name: 'id', column: chosen }];
}
function biasServerGeneratedFromIdParam(entity) {
    const idParam = entity?.routes?.update?.params?.[0];
    if (!idParam) return;
    const col = (entity.schema || []).find(c => c.name === idParam.column);
    if (!col) return;
    col.serverGeneratedOnCreate = true;
    col.immutable = true;
}







function rememberSourcePaths(cfg, entityKey, paths) {
    if (!cfg || !entityKey || !paths || typeof paths !== 'object') return;


    cfg.entities = cfg.entities || {};
    const ent = cfg.entities[entityKey] || (cfg.entities[entityKey] = {});
    ent.sources = ent.sources || { sqlPath: '', harPath: '' };
    cfg.sourcesLastUsed = cfg.sourcesLastUsed || { sqlPath: '', harPath: '' };


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




async function headersEditor(rl, cfg, entityKey) {
    const ent = cfg.entities[entityKey];
    ent.routes = ent.routes || {create: {headers: []}, update: {headers: []}};
    ent.routes.create = ent.routes.create || {headers: []};
    ent.routes.update = ent.routes.update || {headers: []};
    ent.routes.create.headers = Array.isArray(ent.routes.create.headers) ? ent.routes.create.headers : [];
    ent.routes.update.headers = Array.isArray(ent.routes.update.headers) ? ent.routes.update.headers : [];

    const scopeAns = (await askWithDefault(rl, `Edit (C)REATE, (U)PDATE, or (B)OTH headers?`, 'B')).trim().toUpperCase();
    const scope = scopeAns.startsWith('C') ? 'C' : scopeAns.startsWith('U') ? 'U' : 'B';

    let masterSide = scope;
    if (scope === 'B') {
        const chLen = ent.routes.create.headers.length;
        const uhLen = ent.routes.update.headers.length;
        masterSide = (uhLen > chLen) ? 'U' : 'C';
    }

    let headers = masterSide === 'U' ? ent.routes.update.headers : ent.routes.create.headers;

    while (true) {
        const rows = headers.map((h, i) => [String(i + 1), h?.name || '', h?.value || '']);
        console.log(`\nCurrent HEADERS for ${entityKey} — ${masterSide === 'C' ? 'CREATE' : 'UPDATE'}`);
        printTable(['#', 'Name', 'Value'], rows);

        console.log('');
        console.log('Commands:');
        console.log(`  <row# | name>     (edit this header)`);
        console.log('  [A]DD             (add a new header)');
        console.log('  [D]EL <#|name>    (delete a header)');
        console.log('  Q                 (Quit Headers Editor)');
        console.log('');

        const line = (await askWithDefault(rl, ' (#,A,D,Q): ', 'Q')).trim();
        if (!line) continue;
        if (/^(q|quit)$/i.test(line)) {

            headers = sanitizeHeaders(headers);
            if (scope === 'B') {
                ent.routes.create.headers = headers.slice();
                ent.routes.update.headers = headers.slice();
            } else if (masterSide === 'C') {
                ent.routes.create.headers = headers.slice();
            } else {
                ent.routes.update.headers = headers.slice();
            }
            return;
        }

        if (/^(a|add)$/i.test(line)) {
            const name = await askInlinePrefilled(rl, `(${entityKey}) Header name:`, '');
            const value = await askInlinePrefilled(rl, `(${entityKey}) Header value:`, '');
            if (String(name).trim()) headers.push({name: String(name).trim(), value: String(value || '')});
            continue;
        }

        if (/^(d|del)\s+/i.test(line)) {
            const arg = line.replace(/^(d|del)\s+/i, '').trim();
            let idx = -1;
            if (/^\d+$/.test(arg)) {
                idx = parseInt(arg, 10) - 1;
            } else {
                idx = headers.findIndex(h => String(h?.name || '').toLowerCase() === arg.toLowerCase());
            }
            if (idx >= 0 && idx < headers.length) headers.splice(idx, 1);
            continue;
        }


        let idx = -1;
        if (/^\d+$/.test(line)) {
            idx = parseInt(line, 10) - 1;
        } else {
            idx = headers.findIndex(h => String(h?.name || '').toLowerCase() === line.toLowerCase());
        }
        if (idx >= 0 && idx < headers.length) {
            const cur = headers[idx];
            const name = await askInlinePrefilled(rl, `(${entityKey}) Header name:`, cur?.name || '');
            const value = await askInlinePrefilled(rl, `(${entityKey}) Header value:`, cur?.value || '');
            if (String(name).trim()) {
                headers[idx] = {name: String(name).trim(), value: String(value || '')};
            }
            continue;
        }

        console.log('Unknown input.');
    }
}








async function tableEditor(rl, cfg, entityKey) {
    const entity = cfg.entities[entityKey];
    if (!entity.schema) entity.schema = [];


    const _nameLooks = (name) => {
        const n = String(name || '').toLowerCase();
        return {
            email:  n.includes('email'),
            phone:  n.includes('phone') || n.includes('mobile') || n.includes('cell') || n.includes('tel'),
            zip:    n.includes('zip') || n.includes('postal'),
            state:  n.includes('state'),
        };
    };
    const _regexSuggestionForName = (name) => {
        const t = _nameLooks(name);
        if (t.email) return '^address@[a-z]{4,10}\\.(com|net|org)$';
        if (t.phone) return '^\\(\\d{3}\\) \\d{3}-\\d{4}$';
        if (t.zip)   return '^\\d{5}(-\\d{4})?$';
        if (t.state) return '^(?:A[LKSZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])$';
        return '';
    };
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
    function _regexExamplesForType(type) {
        switch (type) {
            case 'email': return [
                { label: '^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$', sample: 'first.last+tag@company.co' },
                { label: '^address@[a-z]{4,10}\\.(com|net|org)$',    sample: 'address@acme.com' },
                { label: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',           sample: 'any@loose.domain' },
            ];
            case 'phone': return [
                { label: '^\\(\\d{3}\\) \\d{3}-\\d{4}$', sample: '(214) 555-7890' },
                { label: '^\\d{3}-\\d{3}-\\d{4}$',       sample: '214-555-7890' },
                { label: '^\\+1 \\d{3} \\d{3} \\d{4}$',  sample: '+1 214 555 7890' },
                { label: '^\\d{10}$',                    sample: '2145557890' },
            ];
            case 'zip': return [
                { label: '^\\d{5}$',           sample: '75001' },
                { label: '^\\d{5}(-\\d{4})?$', sample: '75001-1234' },
            ];
            case 'state': return [
                { label: '^(?:A[LKSZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])$', sample: 'TX, CA, NY only' },
            ];
            default: return [];
        }
    }
    function _inferTypeByName(name) {
        const t = _nameLooks(name);
        if (t.email) return 'email';
        if (t.phone) return 'phone';
        if (t.zip)   return 'zip';
        if (t.state) return 'state';
        return null;
    }
    async function _pickRegexPattern(rl, colName, entityKey, inferredType, currentPattern) {
        const items = _regexExamplesForType(inferredType || '');
        if (!items.length) {

            console.log('\\nRegex help examples:');
            console.log('  • Email: address@[a-z]{4,10}\\\\.(com|net|org)');
            console.log('  • Phone: (214) 555-7890  or  214-555-7890  or  +1 214 555 7890');
            console.log('  • ZIP:   75001  or  75001-1234');
            console.log('  • State: TX/CA/NY (US two-letter codes)\\n');
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

    async function runCreateRegexAssist(rl, entity) {
        if (!entity || !Array.isArray(entity.schema)) return;
        for (const col of entity.schema) {
            if (!col || !col.name) continue;
            if (col.generatePatternRegex) continue;
            const type = _inferTypeByName(col.name);
            if (!type) continue;

            const picked = await _pickRegexPattern(rl,col.name, entityKey, type, '');
            if (picked) col.generatePatternRegex = picked;
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
        console.log('  Q                       (Quit Table Editor)');
        console.log("");

        const line = (await askWithDefault(rl, 'Command (#,A,D,B,R,Q): ', 'Q')).trim();
        if (!line) continue;
        if (/^(q|quit)$/i.test(line)) return;

        if (/^(b|backfill)$/i.test(line)) {
            const { filledCreate, filledUpdate } = await runBackfill(entity);
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
                requiredOnCreate: false,
                inUpdateUrl: false,
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
            const target = delMatch[1].trim();
            let idx = -1;
            if (/^\d+$/.test(target)) {
                const n = Math.max(0, parseInt(target, 10) - 1);
                if (n >= 0 && n < entity.schema.length) idx = n;
            } else {
                const want = target.toLowerCase();
                idx = entity.schema.findIndex(c => String(c.name || '').toLowerCase() === want);
            }
            if (idx < 0) { console.log('Row not found.'); continue; }
            const colName = entity.schema[idx]?.name || `#${idx + 1}`;
            const ok = await askYesNo(rl, `Delete row ${idx + 1} (“${colName}”)?`, false);
            if (ok) { entity.schema.splice(idx, 1); console.log('Row deleted.'); }
            else { console.log('Canceled.'); }
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

        const reqVal = await askInlinePrefilled(rl, `(${entityKey}) Required on create (Y/N): `, col.required ? 'Y' : 'N');
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



async function runBackfill(entity) {
    const cols = entity.schema || [];
    const countCreatePopulated = cols.reduce((n,c)=>n + (!!(c.createApiField||'').trim()), 0);
    const countUpdatePopulated = cols.reduce((n,c)=>n + (!!(c.updateApiField||'').trim()), 0);
    const sourceSide = (countCreatePopulated >= countUpdatePopulated) ? 'create' : 'update';

    let filledCreate = 0, filledUpdate = 0;
    for (const c of cols) {
        const src = (sourceSide === 'create') ? c.createApiField : c.updateApiField;
        if (sourceSide === 'create') {
            if (!c.updateApiField && src) { c.updateApiField = src; filledUpdate++; }
        } else {
            if (!c.createApiField && src) { c.createApiField = src; filledCreate++; }
        }
    }
    return { filledCreate, filledUpdate };
}

function printPreviewTable(cfg, entityKey) {
    const e = cfg.entities[entityKey];
    const headers = ['#','Column','Type','Len','PK','createApiField','updateApiField','Req','Immutable','SrvGenOnCreate','Static','GenRegex'];
    const rows = (e.schema || []).map((c, idx) => [
        String(idx + 1),
        c.name || '',
        c.type || '',
        c.length == null ? '' : String(c.length),
        c.isPk ? 'PK' : '',
        c.createApiField || '',
        c.updateApiField || '',
        c.required ? 'Y' : '',
        c.immutable ? 'Y' : '',
        c.serverGeneratedOnCreate ? 'Y' : '',
        c.staticValue == null ? '' : String(c.staticValue),
        c.generatePatternRegex
            ? (String(c.generatePatternRegex).length > 22
                ? String(c.generatePatternRegex).slice(0, 22) + '...'
                : String(c.generatePatternRegex))
            : ''
    ]);
    printTable(headers, rows);
}


function applyAnalysis(entity, analysis, side ) {
    entity.payload = entity.payload || {};
    entity.payload[side] = entity.payload[side] || { jsonPayloadWrapper: null, requiredKeys: [] };

    if (analysis.wrapper) entity.payload[side].jsonPayloadWrapper = analysis.wrapper;

    entity.payload[side].requiredKeys = [];

    const schema = entity.schema || [];
    fillMappingsFromKeysDeep(schema, analysis, side);

    inferServerGeneratedFields(entity, analysis);
}



