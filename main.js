/*
 * ══════════════════════════════════════════════════════════════════════════════
 *  AE2 Grid Inspector — main.js
 *  Pipeline:
 *    1. loadFiles()          — accepts .json / .snbt / .zip via file picker
 *    2. parseGridJSON()      — parses grid_*.json exports
 *       • machines[]         — each has pos{x,y,z}, level, blockState.Name, data, parts
 *       • item-only machines — {id, item, mainNodeId} resolved via nodes[].location
 *       • nodes[]            — {id, owner, level, location[x,y,z], exposedSides}
 *       • join key           — node.owner → machine.id (absolute world coords)
 *    3. parseSNBTFile()      — supplemental chunk block-entity data
 *       • Filename:  <dim_slug>_<cx>_<cz>.snbt  (e.g. minecraft_overworld_8_11.snbt)
 *       • Coords in SNBT: ABSOLUTE world coords (not chunk-relative)
 *       • Formula (for reference): world = chunk * 16 + (0..15), but x/y/z are already absolute
 *       • Top-level 'id' = block entity type; nested 'id' fields are sub-part types
 *       • Parsed with a proper recursive-descent parseSnbt() that never throws
 *    4. mergeAndIndex()      — dedup by (level|x|y|z|item), build RECORDS
 *    5. computeSuspect()     — flag computation (heuristic; no live channel data in export)
 *       • Channel capacity inferred from cable name suffix: dense→cfgDense, smart→cfgSimple
 *       • Virtual links (p2p/wireless/quantum_link|ring): cfgP2P or cfgWireless
 *       • Classification uses name portion only (after ':'), namespace-agnostic
 *    6. renderTable()        — sortable, filterable data table
 *    7. build3D()            — Three.js instanced-mesh 3-D viewport
 *
 *  Debug mode: append ?debug=1 to URL
 * ══════════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEBUG = new URLSearchParams(location.search).has('debug') &&
              new URLSearchParams(location.search).get('debug') !== '0';

/* ── Helpers ────────────────────────────────────────────── */
const byId = id => document.getElementById(id);

const esc = s => String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const debounce = (fn, wait = 120) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
};

const LS = {
    collapsed:    'ae2_controls_collapsed',
    blacklist:    'ae2_blacklist',
    showBL:       'ae2_show_blacklisted',
    whitelist:    'ae2_whitelist',
    wlEnabled:    'ae2_whitelist_enabled',
    nonConsumers: 'ae2_non_consumers'
};

const loadArr  = k => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : []; } catch { return []; } };
const saveArr  = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const loadBool = (k, d = false) => { const v = localStorage.getItem(k); return v === null ? d : v === '1'; };
const saveBool = (k, v) => localStorage.setItem(k, v ? '1' : '0');

/* ── State ──────────────────────────────────────────────── */
let RAW = [], RECORDS = [];
let BLACKLIST     = loadArr(LS.blacklist).map(s => s.toLowerCase());
let NON_CONSUMERS = loadArr(LS.nonConsumers).map(s => s.toLowerCase());
if (!NON_CONSUMERS.length) NON_CONSUMERS = ['extendedae:ex_inscriber', 'advanced_ae:reaction_chamber'];

let SORT = { col: 'level', dir: 1 }, DIMENSIONS = [], SELECTED_DIM = null;
let WL_LIST = loadArr(LS.whitelist);
if (!WL_LIST.length) WL_LIST = ['ae2', 'megacells', 'ae2things', 'appflux', 'aeinfinitybooster', 'ae2wtlib', 'extendedae', 'ae2networkanalyser', 'advanced_ae'];
let WL_ENABLED = loadBool(LS.wlEnabled, false);

let FACE_PARTS = new Map();
const GHOST_OPACITY = 0.14, UNFILTERED_OPACITY = 0.55;

/* ── Item-name helpers ──────────────────────────────────── */
/** Return the name portion of a modid:name string (everything after first ':').
 *  Classification always uses this to stay namespace-agnostic. */
function nameOf(id) {
    if (!id) return '';
    const c = id.indexOf(':');
    return c >= 0 ? id.slice(c + 1) : id;
}

function canonicalizeLevel(s) {
    if (!s) return 'minecraft:overworld';
    const l = s.toLowerCase();
    if (l.includes('overworld')) return 'minecraft:overworld';
    if (l.includes('nether'))    return 'minecraft:the_nether';
    if (l.includes('end'))       return 'minecraft:the_end';
    if (s.includes(':')) {
        const [ns, rest] = s.split(':');
        return `${ns}:${rest.replace(/^_+/, '')}`;
    }
    // filename slug like "minecraft_overworld" or "allthemodium_the_beyond"
    const idx = s.indexOf('_');
    if (idx > 0) return `${s.slice(0, idx)}:${s.slice(idx + 1)}`;
    return s;
}

const isNS = id => /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(String(id));

/** Classify by name portion only — namespace-agnostic. */
function inferType(id) {
    if (!id) return 'other';
    const n = nameOf(id.toLowerCase());
    if (n === 'cable_bus') return 'bus';
    if (/((smart_)?cable|dense.*cable)$/.test(n) || n === 'quartz_fiber') return 'cable';
    if (n === 'cable_anchor') return 'anchor';
    if (/p2p|wireless.*connect/.test(n)) return 'virt';
    return 'part';
}

const key = (l, x, y, z) => `${l}|${x}|${y}|${z}`;

function isAe2FamilyId(id) {
    if (!id) return false;
    const ns = id.split(':')[0];
    if (!ns) return false;
    if (WL_ENABLED) return WL_LIST.includes(ns);
    const known = new Set(['ae2', 'megacells', 'ae2things', 'appflux', 'aeinfinitybooster', 'ae2wtlib', 'extendedae', 'ae2networkanalyser', 'advanced_ae']);
    if (known.has(ns)) return true;
    return ns.includes('ae2') || nameOf(id).includes('ae2') || ns.includes('advanced_ae');
}

/* ══════════════════════════════════════════════════════════
 *  SNBT RECURSIVE-DESCENT PARSER
 *  Never throws — logs warning and returns null on bad input.
 *
 *  Grammar (simplified):
 *    value   = compound | list | typed_array | string | number
 *    compound= '{' (key ':' value (',' key ':' value)*)? '}'
 *    list    = '[' (value (',' value)*)? ']'
 *    typed_array = '[' ('B'|'I'|'L') ';' (number ',')* number ']'
 *    string  = '"' ... '"'  |  unquoted_chars
 *    number  = [-+]? digits ['.'] digits? [eE] suffix?
 *    suffix  = 'b'|'s'|'l'|'f'|'d'|'L'
 *    key     = string
 * ══════════════════════════════════════════════════════════ */
function parseSnbt(str) {
    /* Self-test literals drawn from real SNBT files:
     *   parseSnbt('{id: "ae2:cable_bus", x: 138, y: 87, z: 179, keepPacked: 0b}')
     *     -> { id: 'ae2:cable_bus', x: 138, y: 87, z: 179, keepPacked: 0 }
     *   parseSnbt('{e: 25.0d, p: 0}') -> { e: 25, p: 0 }
     *   parseSnbt('{arr: [B; 1b, 2b, 3b]}') -> { arr: [1,2,3] }
     *   parseSnbt('{arr: [L; 1234567890123L, 9876543210L]}') -> { arr: [1234567890123, 9876543210] }
     *   parseSnbt('{nested: {id: "ae2:storage_bus"}, x: 5}') -> { nested: {id:'ae2:storage_bus'}, x: 5 }
     */
    if (typeof str !== 'string') { console.warn('[SNBT] non-string input'); return null; }
    try {
        let pos = 0;

        function peek()  { skipWs(); return pos < str.length ? str[pos] : ''; }
        function next()  { skipWs(); return pos < str.length ? str[pos++] : ''; }
        function skipWs(){ while (pos < str.length && /\s/.test(str[pos])) pos++; }

        function expect(ch) {
            const c = next();
            if (c !== ch) throw new Error(`Expected '${ch}' got '${c}' at ${pos}`);
        }

        function parseValue() {
            const c = peek();
            if (c === '{') return parseCompound();
            if (c === '[') return parseListOrArray();
            if (c === '"') return parseQuotedString();
            return parseUnquoted();
        }

        function parseCompound() {
            expect('{');
            const obj = {};
            if (peek() === '}') { pos++; return obj; }
            while (pos < str.length) {
                const k = parseKey();
                skipWs();
                expect(':');
                obj[k] = parseValue();
                skipWs();
                if (peek() === ',') { pos++; continue; }
                if (peek() === '}') { pos++; break; }
                // tolerate missing separator
                break;
            }
            return obj;
        }

        function parseListOrArray() {
            expect('[');
            skipWs();
            // Check for typed array: [B; ...] [I; ...] [L; ...]
            if (pos + 1 < str.length && /[BIL]/i.test(str[pos]) && str[pos + 1] === ';') {
                pos += 2; // skip type char and semicolon
                const arr = [];
                while (pos < str.length && peek() !== ']') {
                    arr.push(parseUnquoted());
                    skipWs();
                    if (peek() === ',') pos++;
                }
                expect(']');
                return arr;
            }
            const arr = [];
            if (peek() === ']') { pos++; return arr; }
            while (pos < str.length) {
                arr.push(parseValue());
                skipWs();
                if (peek() === ',') { pos++; continue; }
                if (peek() === ']') { pos++; break; }
                break; // tolerate
            }
            return arr;
        }

        function parseQuotedString() {
            expect('"');
            let s = '';
            while (pos < str.length) {
                const c = str[pos++];
                if (c === '\\') { s += str[pos++] || ''; continue; }
                if (c === '"') break;
                s += c;
            }
            return s;
        }

        function parseKey() {
            skipWs();
            if (peek() === '"') return parseQuotedString();
            let s = '';
            while (pos < str.length && /[a-zA-Z0-9_.\-#+]/.test(str[pos])) s += str[pos++];
            return s;
        }

        function parseUnquoted() {
            skipWs();
            let s = '';
            while (pos < str.length && /[^,\]\}\s]/.test(str[pos])) s += str[pos++];
            s = s.trim();
            // Strip numeric suffix
            const numStr = s.replace(/[bBsSlLfFdD]$/, '');
            const n = Number(numStr);
            if (numStr !== '' && !isNaN(n)) return n;
            return s;
        }

        skipWs();
        if (pos >= str.length) return null;
        const result = parseValue();
        return result;
    } catch (err) {
        console.warn('[SNBT] parse error:', err.message, '| input snippet:', str.slice(0, 120));
        return null;
    }
}

/* ── File loading ───────────────────────────────────────── */
async function loadFiles(files) {
    RAW = [];
    FACE_PARTS = new Map();
    const zips = [], plains = [];
    for (const f of files) (f.name.toLowerCase().endsWith('.zip') ? zips : plains).push(f);

    for (const f of plains) {
        const text = await f.text();
        if (f.name.endsWith('.json'))  parseGridJSON(text, f.name);
        else if (f.name.endsWith('.snbt')) parseSNBTFile(text, f.name);
    }
    for (const f of zips) {
        const zip = await JSZip.loadAsync(f);
        for (const [p, e] of Object.entries(zip.files)) {
            if (!e.dir && /(^|\/)grid_.*\.json$/i.test(p)) {
                const t = await e.async('string');
                parseGridJSON(t, p);
            }
        }
        for (const [p, e] of Object.entries(zip.files)) {
            if (!e.dir && /(^|\/)chunks\/.*\.snbt$/i.test(p)) {
                const t = await e.async('string');
                parseSNBTFile(t, p);
            }
        }
    }

    mergeAndIndex();
    computeSuspect();

    const dims = [...new Set(RECORDS.map(r => r.level))];
    SELECTED_DIM = dims[0] || null;
    renderDimSelect();

    if (DEBUG) debugDump();

    byId('emptyState').classList.add('hidden');
    byId('unloadRow').classList.add('visible');
    renderTable();
    build3D(true);
}

/* ── parseGridJSON ──────────────────────────────────────── */
/*
 * grid_*.json structure:
 *   { id, disposed, machines[], nodes[], services{} }
 *
 * machines can be:
 *   A) Full machine: { id, pos{x,y,z}, level, blockState{Name}, data{cable{id}, <face>{id,...}}, parts{<face>{item,id,mainNodeId}} }
 *   B) Item-only:    { id, item, mainNodeId }  — cable-bus part; pos resolved via nodes[]
 *
 * nodes[]: { id, owner, level, location[x,y,z], exposedSides }
 *   node.owner = machine.id that owns this node
 *   node.id == machine.id when owner == self
 *   location = absolute world coordinates [x, y, z]
 *
 * Join for item-only machines: machine.mainNodeId → node.id → node.location
 *
 * Channel data: gn{p, e} where p=power used (always 0 in export), e=idle power drain (25 RF/t).
 * NO live channel counts are exported; capacity is inferred from cable type.
 */
function parseGridJSON(text, src) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { console.warn('[JSON] parse error in', src, e.message); return; }

    // Build node lookup: node.id -> {level, loc:[x,y,z]}
    const nodeInfo = new Map();
    for (const n of (obj.nodes || [])) {
        nodeInfo.set(n.id, {
            level: canonicalizeLevel(n.level || 'minecraft:overworld'),
            loc: Array.isArray(n.location) && n.location.length === 3 ? n.location : null
        });
    }

    const gridId = obj.id ?? obj.name ?? '';

    const push = (level, x, y, z, id) => {
        if (!isNS(id)) return;
        RAW.push({
            level: canonicalizeLevel(level), x, y, z,
            item: id.toLowerCase(), type: inferType(id),
            grid: gridId, src
        });
    };

    function setFace(level, x, y, z, face, id) {
        const k = `${canonicalizeLevel(level)}|${x | 0}|${y | 0}|${z | 0}`;
        let m = FACE_PARTS.get(k);
        if (!m) { m = {}; FACE_PARTS.set(k, m); }
        m[face] = (id || '').toLowerCase();
    }

    const FACES = ['center', 'up', 'down', 'north', 'south', 'east', 'west'];

    for (const m of (obj.machines || [])) {
        let level, x, y, z;

        if (m.pos && Number.isFinite(m.pos.x) && Number.isFinite(m.pos.y) && Number.isFinite(m.pos.z)) {
            // Type A: full machine with explicit position
            level = canonicalizeLevel(m.level || 'minecraft:overworld');
            ({ x, y, z } = m.pos);
        } else if (m.mainNodeId != null) {
            // Type B: item-only machine — resolve position via its node
            const ni = nodeInfo.get(m.mainNodeId);
            if (!ni || !ni.loc) continue;
            level = ni.level;
            [x, y, z] = ni.loc;
        } else {
            continue; // no position available
        }

        const ix = x | 0, iy = y | 0, iz = z | 0;
        const havePos = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
        if (!havePos) continue;

        // Block entity / machine item
        const name = (m.blockState?.Name || m.item || '').toLowerCase();
        if (name) push(level, ix, iy, iz, name);

        // Face parts from machine.parts (the authoritative list of installed parts)
        if (m.parts) {
            for (const f of FACES) {
                const p = m.parts[f];
                if (p?.item) {
                    const pid = p.item.toLowerCase();
                    push(level, ix, iy, iz, pid);
                    setFace(level, ix, iy, iz, f, pid);
                }
            }
        }

        // Additional item data from machine.data (cable, face sub-data)
        const data = m.data;
        if (data) {
            const cableId = (data.cable?.id || '').toLowerCase();
            if (cableId) {
                push(level, ix, iy, iz, cableId);
                setFace(level, ix, iy, iz, 'center', cableId);
            }
            for (const f of FACES) {
                const fd = data[f];
                if (!fd || typeof fd !== 'object') continue;
                const did = (fd.id || fd.outer?.id || '').toLowerCase();
                if (did) {
                    push(level, ix, iy, iz, did);
                    setFace(level, ix, iy, iz, f, did);
                }
            }
        }
    }
}

/* ── SNBT parsing ───────────────────────────────────────── */
/*
 * Chunk SNBT files: chunks/<dim_slug>_<cx>_<cz>.snbt
 *   dim_slug examples: minecraft_overworld, allthemodium_mining, allthemodium_the_beyond
 *   Coordinates in SNBT x/y/z fields are ABSOLUTE world coordinates.
 *   The chunk coords in the filename are informational only (formula: world = chunk*16 + offset).
 *
 * Block entity structure in SNBT:
 *   { id: "ae2:cable_bus", x: 138, y: 87, z: 179, keepPacked: 0b,
 *     cable: { id: "ae2:white_smart_cable", gn: { e: 25.0d, p: 0 } },
 *     south: { id: "ae2:storage_bus", ... },
 *     west:  { id: "ae2:storage_bus", ... } }
 *
 * IMPORTANT: 'cable.id' appears BEFORE the block-entity 'id' field in sorted NBT output.
 * Using a regex for the first 'id:' match would capture the cable type, not the BE type.
 * The recursive-descent parser resolves this by giving us the full compound object,
 * from which we can read obj.id (the BE type) and obj.<face>.id (face parts) separately.
 */
function parseSNBTFile(text, src) {
    // Determine dimension from filename slug
    // Pattern: chunks/<dim_slug>_<cx>_<cz>.snbt  (cx/cz may be negative)
    const mm = /chunks\/([^/]+?)_-?\d+_-?\d+\.snbt$/i.exec(src);
    const level = canonicalizeLevel(mm ? mm[1] : 'minecraft:overworld');

    // Extract the block_entities array text
    const beStart = text.search(/block_entities\s*:\s*\[/i);
    if (beStart < 0) return;

    // Find the matching '[' and walk to balanced ']'
    let bracketPos = text.indexOf('[', beStart);
    if (bracketPos < 0) return;

    let depth = 0, arrEnd = -1;
    for (let i = bracketPos; i < text.length; i++) {
        if (text[i] === '[') depth++;
        else if (text[i] === ']') { depth--; if (depth === 0) { arrEnd = i; break; } }
    }
    if (arrEnd < 0) return;
    const arrSlice = text.slice(bracketPos, arrEnd + 1);

    // Iterate top-level {} objects within the array
    let d2 = 0, objStart = -1;
    for (let i = 0; i < arrSlice.length; i++) {
        const c = arrSlice[i];
        if (c === '{') { if (d2 === 0) objStart = i; d2++; }
        else if (c === '}') {
            d2--;
            if (d2 === 0 && objStart >= 0) {
                const objText = arrSlice.slice(objStart, i + 1);
                objStart = -1;
                processSNBTBlockEntity(objText, level, src);
            }
        }
    }
}

const SNBT_FACES = ['center', 'up', 'down', 'north', 'south', 'east', 'west'];

function processSNBTBlockEntity(objText, level, src) {
    const obj = parseSnbt(objText);
    if (!obj || typeof obj !== 'object') return;

    // The block entity type id is the top-level 'id' field
    const beId = (typeof obj.id === 'string' ? obj.id : '').toLowerCase();
    if (!beId) return;
    if (!isAe2FamilyId(beId)) {
        // The BE itself isn't AE2 family — but it might contain AE2 parts
        // (unlikely for non-AE2 BEs; skip for performance)
        return;
    }

    // x, y, z are absolute world coords at top level
    const x = obj.x, y = obj.y, z = obj.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const ix = x | 0, iy = y | 0, iz = z | 0;

    // Push the block entity type
    RAW.push({ level, x: ix, y: iy, z: iz, item: beId, type: inferType(beId), grid: '', src });

    // Push cable (center face)
    const cableId = (typeof obj.cable?.id === 'string' ? obj.cable.id : '').toLowerCase();
    if (cableId && isNS(cableId)) {
        RAW.push({ level, x: ix, y: iy, z: iz, item: cableId, type: inferType(cableId), grid: '', src });
        const k = `${level}|${ix}|${iy}|${iz}`;
        let fm = FACE_PARTS.get(k); if (!fm) { fm = {}; FACE_PARTS.set(k, fm); }
        fm['center'] = cableId;
    }

    // Push face part ids
    for (const f of SNBT_FACES) {
        if (f === 'center') continue;
        const faceData = obj[f];
        if (!faceData || typeof faceData !== 'object') continue;
        const partId = (typeof faceData.id === 'string' ? faceData.id : '').toLowerCase();
        if (!partId || !isNS(partId) || !isAe2FamilyId(partId)) continue;
        RAW.push({ level, x: ix, y: iy, z: iz, item: partId, type: inferType(partId), grid: '', src });
        const k = `${level}|${ix}|${iy}|${iz}`;
        let fm = FACE_PARTS.get(k); if (!fm) { fm = {}; FACE_PARTS.set(k, fm); }
        fm[f] = partId;
    }
}

function mergeAndIndex() {
    const seen = new Set(), out = [];
    for (const r of RAW) {
        const k = `${key(r.level, r.x, r.y, r.z)}|${r.item}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ ...r, level: canonicalizeLevel(r.level) });
    }
    RECORDS = out;
    DIMENSIONS = [...new Set(RECORDS.map(r => r.level))].sort();
}

function renderDimSelect() {
    const s = byId('dim3d');
    s.innerHTML = '';
    for (const d of DIMENSIONS) {
        const o = document.createElement('option');
        o.value = d;
        o.textContent = d;
        if (d === SELECTED_DIM) o.selected = true;
        s.appendChild(o);
    }
}

/* ── Filter/blacklist helpers ───────────────────────────── */
function nsAllowed(id) {
    if (!WL_ENABLED) return true;
    const ns = (id || '').split(':')[0];
    return WL_LIST.includes(ns);
}

function blMatches(id) {
    if (!id) return false;
    const [mod] = id.split(':');
    id = id.toLowerCase();
    return BLACKLIST.includes(id) || BLACKLIST.includes(`${mod}:*`);
}

/* ── List renderers ─────────────────────────────────────── */
function renderList(paneId, items, onRemove) {
    const div = byId(paneId);
    div.innerHTML = '';
    for (const e of items) {
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = e + ' ';
        const b = document.createElement('button');
        b.textContent = '✕';
        b.onclick = () => onRemove(e);
        pill.appendChild(b);
        div.appendChild(pill);
        div.appendChild(document.createTextNode(' '));
    }
}

function renderBlacklist()    { renderList('blList', BLACKLIST, e => { BLACKLIST = BLACKLIST.filter(x => x !== e); saveArr(LS.blacklist, BLACKLIST); computeSuspect(); renderAll(); }); }
function renderNonConsumers() { renderList('ncList', NON_CONSUMERS, e => { NON_CONSUMERS = NON_CONSUMERS.filter(x => x !== e); saveArr(LS.nonConsumers, NON_CONSUMERS); computeSuspect(); renderAll(); }); }
function renderWhitelist()    { renderList('wlList', WL_LIST, ns => { WL_LIST = WL_LIST.filter(x => x !== ns); saveArr(LS.whitelist, WL_LIST); renderAll(); }); byId('wlEnabled').checked = WL_ENABLED; }

/* ── Edge/cable helpers ─────────────────────────────────── */
const DIRS = { '1,0,0': 'east', '-1,0,0': 'west', '0,1,0': 'up', '0,-1,0': 'down', '0,0,1': 'south', '0,0,-1': 'north' };
const OPP  = { up: 'down', down: 'up', north: 'south', south: 'north', east: 'west', west: 'east' };

function faceAt(level, x, y, z, face) {
    const m = FACE_PARTS.get(`${level}|${x}|${y}|${z}`);
    return m ? m[face] : undefined;
}

function isBarrierId(id) {
    if (!id) return false;
    const n = nameOf(id);
    return n === 'quartz_fiber' || n === 'cable_anchor';
}

const COLOR_NAMES = ['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black'];

function cableCenterId(level, x, y, z) { return faceAt(level, x, y, z, 'center'); }

function cableColorFromId(id) {
    if (!id) return null;
    // Match color prefix: <color>_<type>_cable or <color>_dense_... etc.
    const n = nameOf(id);
    const m = n.match(/^([a-z_]+?)_((?:smart_)?(?:dense_)?(?:covered_)?(?:glass_)?cable)$/i);
    if (m) { const c = m[1].toLowerCase(); if (COLOR_NAMES.includes(c)) return c; }
    return null;
}

function colorsBlock(a, b) { return a && b && a !== b; }

function edgeBlocked(level, x, y, z, dx, dy, dz) {
    const f = DIRS[`${dx},${dy},${dz}`], nf = OPP[f];
    const a = faceAt(level, x, y, z, f), b = faceAt(level, x + dx, y + dy, z + dz, nf);
    if (isBarrierId(a) || isBarrierId(b)) return true;
    const cA = cableCenterId(level, x, y, z), cB = cableCenterId(level, x + dx, y + dy, z + dz);
    if (colorsBlock(cableColorFromId(cA), cableColorFromId(cB))) return true;
    return false;
}

/* ── Flag computation ───────────────────────────────────── */
/*
 * NOTE: The AE2 grid export does NOT contain live channel-usage counts.
 *       The gn{p, e} fields represent idle power draw (e ≈ 25 RF/t), not channel load.
 *       All flag logic is therefore HEURISTIC, based on cable type and device type.
 *
 *       Thresholds are always read from UI inputs at compute time:
 *         cfgSimple   — max channels on a smart/covered/glass cable (default 8)
 *         cfgDense    — max channels on a dense cable (default 32)
 *         cfgP2P      — virtual channels through a p2p tunnel (default 32)
 *         cfgWireless — virtual channels through wireless/quantum links (default 32)
 *
 *       Classification uses nameOf() — namespace-agnostic.
 */
function computeSuspect() {
    // Read thresholds from UI at computation time
    const simple  = +byId('cfgSimple').value   || 8;
    const dense   = +byId('cfgDense').value    || 32;
    const p2p     = +byId('cfgP2P').value      || 32;
    const wrl     = +byId('cfgWireless').value || 32;

    // ── Classification predicates (namespace-agnostic via nameOf) ──

    const isCable = id => {
        if (!id) return false;
        const n = nameOf(id);
        return /((smart_)?cable|dense.*cable)$/.test(n) || n === 'quartz_fiber';
    };
    const isDenseCable = id => !!id && /dense/.test(nameOf(id)) && isCable(id);
    const isQuartz     = id => !!id && nameOf(id) === 'quartz_fiber';
    const isAnchor     = id => !!id && nameOf(id) === 'cable_anchor';
    const isBarrier    = id => isQuartz(id) || isAnchor(id);
    const isController = id => !!id && /controller/.test(nameOf(id));

    // Virtual channel links: p2p tunnels, wireless APs, quantum links/rings, ae2wtlib bridges
    // Uses name portion only. Deliberately excludes "quantum_accelerator", "quantum_structure"
    // (those are crafting/multiblock parts, not network links).
    const isLink = id => {
        if (!id) return false;
        const n = nameOf(id.toLowerCase());
        return /p2p|wireless|quantum_link|quantum_ring|quantum_bridge|quantum_tunnel/.test(n);
    };

    const isWirelessLink = id => {
        if (!id) return false;
        const n = nameOf(id.toLowerCase());
        return /wireless|quantum_link|quantum_ring|quantum_bridge|quantum_tunnel/.test(n);
    };

    const NON_CONS_SET = new Set(NON_CONSUMERS.map(s => s.toLowerCase()));

    // Multiblock structures: all component blocks together count as ONE channel consumer.
    // Returns a stable type-string if the item is a multiblock component, else null.
    // Uses name portion only (namespace-agnostic). isLink() exclusion prevents matching
    // quantum_link / quantum_ring / quantum_bridge / quantum_tunnel.
    const multiblockType = id => {
        if (!id) return null;
        const n = nameOf(id.toLowerCase());
        if (/^assembler_matrix/.test(n))                             return 'assembler_matrix';
        if (/^quantum_/.test(n) && !isLink(id) && !isController(id)) return 'quantum_computer';
        return null;
    };

    // Consumer RE: tested against the full id string (namespace + name).
    // Name-portion patterns are broad enough to match any mod that follows AE2 naming conventions.
    const CONSUMER_RE = /(pattern_provider|interface|import_bus|export_bus|storage_bus|formation_plane|annihilation_plane|assembler|crafting_monitor|io_port|drive|charger|level_emitter|condenser|quantum_accelerator|quantum_multi_threader|requester)/i;

    function isConsumer(id) {
        if (!id) return false;
        if (id === 'ae2:cable_bus' || isCable(id) || isBarrier(id) || isLink(id) || isController(id)) return false;
        if (blMatches(id)) return false;
        if (NON_CONS_SET.has(id.toLowerCase())) return false;
        if (multiblockType(id)) return true;  // all multiblock component blocks are consumers
        return CONSUMER_RE.test(id);
    }

    // All consumers are passthrough: a chain of consumers adjacent to each other
    // all draw channels from the cable they're ultimately connected to.
    const isPassThroughConsumer = isConsumer;
    const POS = r => `${r.level}|${r.x}|${r.y}|${r.z}`;
    const SIX = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

    // Build position index
    const idx = new Map();
    for (const r of RECORDS) {
        if (!nsAllowed(r.item)) continue;
        const k = POS(r);
        let a = idx.get(k);
        if (!a) idx.set(k, a = []);
        a.push(r);
    }
    const hasBarrierAt = (L, x, y, z) => (idx.get(`${L}|${x}|${y}|${z}`) || []).some(r => isBarrier(r.item));

    // Per-position channel capacity and virtual capacity
    const capAt = new Map(), virtAt = new Map(), hasBusAt = new Map();
    for (const [k, items] of idx) {
        let cap = 0, virt = 0, hasBus = false;
        for (const rr of items) {
            const id = rr.item;
            if (id === 'ae2:cable_bus') hasBus = true;
            if (isCable(id)) {
                if (isDenseCable(id)) cap = Math.max(cap, dense);
                else if (isQuartz(id)) cap = Math.max(cap, 0);
                else cap = Math.max(cap, simple);
            }
            if (isLink(id)) {
                virt = Math.max(virt, isWirelessLink(id) ? wrl : p2p);
            }
        }
        if (cap)    capAt.set(k, cap);
        if (virt)   virtAt.set(k, virt);
        if (hasBus) hasBusAt.set(k, true);
    }

    // Pre-compute multiblock cluster IDs.
    // Connected blocks sharing the same multiblock type form one cluster and together
    // count as a single channel consumer regardless of how many blocks the structure has.
    const multiblockClusterOf = new Map(); // posKey -> clusterKey
    {
        const mbSeen = new Set();
        let nextMb = 0;
        for (const [k, recs] of idx) {
            if (mbSeen.has(k)) continue;
            const seed = recs.find(r => multiblockType(r.item));
            if (!seed) continue;
            const mbT = multiblockType(seed.item);
            const clusterKey = `mb${nextMb++}`;
            const q = [{ level: seed.level, x: seed.x, y: seed.y, z: seed.z }];
            mbSeen.add(k);
            multiblockClusterOf.set(k, clusterKey);
            while (q.length) {
                const cur = q.shift();
                for (const [dx, dy, dz] of SIX) {
                    const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
                    const nk = `${cur.level}|${nx}|${ny}|${nz}`;
                    if (mbSeen.has(nk)) continue;
                    const nrecs = idx.get(nk) || [];
                    if (!nrecs.some(r => multiblockType(r.item) === mbT)) continue;
                    mbSeen.add(nk);
                    multiblockClusterOf.set(nk, clusterKey);
                    q.push({ level: cur.level, x: nx, y: ny, z: nz });
                }
            }
        }
    }

    // Local SUS check: cable_bus positions where consumer count > cable capacity.
    // Consumer chains: consumers adjacent to other consumers act as passthrough —
    // every consumer in the chain draws a channel from the cable_bus it leads back to.
    const susLocal = new Set();

    // Count consumers reachable from a cable_bus via consumer-to-consumer adjacency.
    // Also counts consumers installed directly on the cable_bus (same-position parts).
    // Stops at other cable_bus positions (they own their own consumers).
    const countConsumerChain = (cL, cX, cY, cZ) => {
        const seen = new Set([`${cL}|${cX}|${cY}|${cZ}`]);
        const seenMbClusters = new Set();
        // Returns 1 if this consumer should be counted (deduplicates multiblock clusters).
        const countOne = (id, posKey) => {
            if (!isConsumer(id)) return 0;
            const mb = multiblockClusterOf.get(posKey);
            if (mb) {
                if (seenMbClusters.has(mb)) return 0;
                seenMbClusters.add(mb);
            }
            return 1;
        };
        let total = 0;
        const ownKey = `${cL}|${cX}|${cY}|${cZ}`;
        for (const rr of (idx.get(ownKey) || [])) total += countOne(rr.item, ownKey);
        // BFS outward through consumer chains
        const queue = [[cX, cY, cZ]];
        while (queue.length) {
            const [qx, qy, qz] = queue.shift();
            for (const [dx, dy, dz] of SIX) {
                if (edgeBlocked(cL, qx, qy, qz, dx, dy, dz)) continue;
                const nx = qx + dx, ny = qy + dy, nz = qz + dz;
                const nk = `${cL}|${nx}|${ny}|${nz}`;
                if (seen.has(nk)) continue;
                if (hasBarrierAt(cL, nx, ny, nz)) continue;
                seen.add(nk);
                const nitems = idx.get(nk) || [];
                if (nitems.some(it => it.item === 'ae2:cable_bus')) continue;
                let posHasCons = false;
                for (const rr of nitems) {
                    total += countOne(rr.item, nk);
                    if (isConsumer(rr.item)) posHasCons = true;
                }
                if (posHasCons) queue.push([nx, ny, nz]);
            }
        }
        return total;
    };

    for (const [k, items] of idx) {
        if (!items.some(it => it.item === 'ae2:cable_bus')) continue;
        const [L, x, y, z] = k.split('|');
        const X = +x, Y = +y, Z = +z;
        let cap = (capAt.get(k) || 0) + (virtAt.get(k) || 0);
        for (const [dx, dy, dz] of SIX) {
            if (edgeBlocked(L, X, Y, Z, dx, dy, dz)) continue;
            const nx = X + dx, ny = Y + dy, nz = Z + dz;
            if (hasBarrierAt(L, nx, ny, nz)) continue;
            const nk = `${L}|${nx}|${ny}|${nz}`;
            const nTot = (capAt.get(nk) || 0) + (virtAt.get(nk) || 0);
            if (nTot > cap) cap = nTot;
        }
        if (cap === 0) cap = simple; // unconfigured cable
        if (countConsumerChain(L, X, Y, Z) > cap) susLocal.add(k);
    }

    // Set per-record flags (pre-island)
    for (const r of RECORDS) {
        const id = r.item, k = POS(r);
        r._isSus     = susLocal.has(k) && id === 'ae2:cable_bus';
        r._isCap     = (isCable(id) && !isQuartz(id)) || isController(id);
        r._isVirt    = isLink(id);
        r._isCons    = isConsumer(id);
        r._isStarved = false;
    }

    // Island / network BFS for STARVED detection
    const isNodeAt = (L, x, y, z) => {
        const arr = idx.get(`${L}|${x}|${y}|${z}`) || [];
        return arr.some(rr => rr.item === 'ae2:cable_bus' || isPassThroughConsumer(rr.item));
    };

    const busSeeds = RECORDS.filter(r => r.item === 'ae2:cable_bus');
    const visited  = new Set();
    const islandOf = new Map();
    let nextId = 0;

    function bfs(start) {
        const L = start.level;
        const q = [start];
        while (q.length) {
            const cur = q.pop();
            const k = POS(cur);
            if (visited.has(k)) continue;
            visited.add(k);
            islandOf.set(k, nextId);
            for (const [dx, dy, dz] of SIX) {
                const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
                if (edgeBlocked(L, cur.x, cur.y, cur.z, dx, dy, dz)) continue;
                if (hasBarrierAt(L, nx, ny, nz)) continue;
                if (!isNodeAt(L, nx, ny, nz)) continue;
                const nk = `${L}|${nx}|${ny}|${nz}`;
                if (visited.has(nk)) continue;
                q.push({ level: L, x: nx, y: ny, z: nz });
            }
        }
    }

    for (const b of busSeeds) {
        const k = POS(b);
        if (!visited.has(k)) { bfs(b); nextId++; }
    }
    const islandCount = nextId;

    function islandFor(r) {
        const k = POS(r);
        if (islandOf.has(k)) return islandOf.get(k);
        for (const [dx, dy, dz] of SIX) {
            const nk = `${r.level}|${r.x + dx}|${r.y + dy}|${r.z + dz}`;
            if (islandOf.has(nk)) return islandOf.get(nk);
        }
        return undefined;
    }

    const demand       = new Array(islandCount).fill(0);
    const hasCtl       = new Array(islandCount).fill(false);
    const islandHasBus = new Array(islandCount).fill(false);
    const islandSeenClusters = new Map(); // island id -> Set<clusterKey>

    for (const r of RECORDS) {
        if (!nsAllowed(r.item)) continue;
        const isl = islandFor(r);
        if (isl === undefined) continue;
        if (isController(r.item)) hasCtl[isl] = true;
        if (r.item === 'ae2:cable_bus') islandHasBus[isl] = true;
        if (r._isCons || isPassThroughConsumer(r.item)) {
            const mb = multiblockClusterOf.get(POS(r));
            if (mb) {
                // Whole multiblock = 1 channel; only count the cluster once per island.
                let s = islandSeenClusters.get(isl);
                if (!s) { s = new Set(); islandSeenClusters.set(isl, s); }
                if (!s.has(mb)) { s.add(mb); demand[isl]++; }
            } else {
                demand[isl]++;
            }
        }
    }

    // Virtual link capacity per island (optional heuristic)
    const virtHeuristic = byId('virtHeuristic').checked;
    const islandLinkCap = new Array(islandCount).fill(0);
    if (virtHeuristic) {
        for (const r of RECORDS) {
            if (!nsAllowed(r.item)) continue;
            const isl = islandFor(r);
            if (isl === undefined) continue;
            if (!isLink(r.item)) continue;
            const cap = isWirelessLink(r.item) ? wrl : p2p;
            islandLinkCap[isl] += cap;
        }
    }

    // Per-island maximum cable capacity
    const capAtIsland = new Map();
    for (const [k, cap] of capAt) {
        const isl = islandOf.get(k);
        if (isl !== undefined) capAtIsland.set(isl, Math.max(capAtIsland.get(isl) || 0, cap));
    }
    for (let i = 0; i < islandCount; i++) {
        if ((capAtIsland.get(i) || 0) === 0 && islandHasBus[i]) capAtIsland.set(i, simple);
    }

    // STARVED: demand exceeds available capacity for the island
    const starved = new Array(islandCount).fill(false);
    for (let i = 0; i < islandCount; i++) {
        const ctrlLimit = hasCtl[i] ? 32 : 8;
        const base      = Math.min(capAtIsland.get(i) || 0, ctrlLimit);
        const available = base + islandLinkCap[i];
        if (demand[i] > available) starved[i] = true;
    }

    for (const r of RECORDS) {
        const isl = islandFor(r);
        if (isl === undefined) continue;
        if (starved[isl] && (r._isCons || isPassThroughConsumer(r.item))) r._isStarved = true;
        if (starved[isl] && r.item === 'ae2:cable_bus') r._isSus = true;
    }

    // Compose flag string
    for (const r of RECORDS) {
        const f = [];
        if (r._isSus)     f.push('SUS');
        if (r._isStarved) f.push('STARVED');
        if (r._isCap)     f.push('CAP');
        if (r._isVirt)    f.push('VIRT');
        if (r._isCons || isPassThroughConsumer(r.item)) f.push('CONS');
        r._flags = f.join(', ');
    }
}

/* ── Debug mode ─────────────────────────────────────────── */
function debugDump() {
    console.group('[AE2-Inspector] Debug dump (debug=1)');
    console.log('Total records:', RECORDS.length);

    // First 20 records
    const sample = RECORDS.slice(0, 20).map(r => ({
        level: r.level, item: r.item, x: r.x, y: r.y, z: r.z,
        type: r.type, grid: r.grid,
        flags: r._flags || '—',
        isSus: r._isSus, isStarved: r._isStarved, isCap: r._isCap, isVirt: r._isVirt, isCons: r._isCons
    }));
    console.table(sample);

    // Count per flag
    const flagCounts = { SUS: 0, STARVED: 0, CAP: 0, VIRT: 0, CONS: 0, NONE: 0 };
    for (const r of RECORDS) {
        if (r._isSus)     flagCounts.SUS++;
        if (r._isStarved) flagCounts.STARVED++;
        if (r._isCap)     flagCounts.CAP++;
        if (r._isVirt)    flagCounts.VIRT++;
        if (r._isCons)    flagCounts.CONS++;
        if (!r._isSus && !r._isStarved && !r._isCap && !r._isVirt && !r._isCons) flagCounts.NONE++;
    }
    console.log('Flag counts:', flagCounts);

    // Distinct levels
    console.log('Distinct levels:', [...new Set(RECORDS.map(r => r.level))]);

    // Join mismatches: records with no grid source (came from SNBT only, not grid JSON)
    const snbtOnly = RECORDS.filter(r => r.grid === '' && r.src?.endsWith('.snbt'));
    console.log('SNBT-only records (no grid JSON match):', snbtOnly.length);

    console.groupEnd();
}

/* ── Filters & table ────────────────────────────────────── */
function wild(str, pat) {
    if (!pat) return true;
    if (pat.includes('*')) {
        const re = new RegExp('^' + pat.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
        return re.test(str);
    }
    return str.toLowerCase().includes(pat.toLowerCase());
}

function range(v, min, max) {
    if (min !== '' && v < +min) return false;
    if (max !== '' && v > +max) return false;
    return true;
}

function readFilters() {
    return {
        level:  (byId('fLevel').value  || '').trim(),
        item:   (byId('fItem').value   || '').trim(),
        xMin:   byId('fXmin').value,
        xMax:   byId('fXmax').value,
        yMin:   byId('fYmin').value,
        yMax:   byId('fYmax').value,
        zMin:   byId('fZmin').value,
        zMax:   byId('fZmax').value,
        flags:  byId('fFlags').value,
        showBL: byId('showBL').checked
    };
}

function isFilterActive() {
    const f = readFilters();
    return !!(f.level || f.item || (f.flags && f.flags !== 'any') ||
              f.xMin !== '' || f.xMax !== '' || f.yMin !== '' || f.yMax !== '' || f.zMin !== '' || f.zMax !== '');
}

function flagsMatch(r, m) {
    if (m === 'any')     return true;
    if (m === 'none')    return !r._isSus && !r._isStarved && !r._isCap && !r._isVirt && !r._isCons;
    if (m === 'sus')     return r._isSus;
    if (m === 'starved') return r._isStarved;
    if (m === 'cap')     return r._isCap;
    if (m === 'virt')    return r._isVirt;
    if (m === 'cons')    return r._isCons;
    return true;
}

function filteredTableRows() {
    const f = readFilters();
    let rows = RECORDS.filter(r => nsAllowed(r.item));
    if (f.level) rows = rows.filter(r => wild(r.level, f.level));
    if (f.item)  rows = rows.filter(r => wild(r.item,  f.item));
    rows = rows.filter(r => range(r.x, f.xMin, f.xMax) && range(r.y, f.yMin, f.yMax) && range(r.z, f.zMin, f.zMax));
    rows = rows.filter(r => flagsMatch(r, f.flags));
    if (!f.showBL) rows = rows.filter(r => !blMatches(r.item));
    return rows;
}

function sortRows(rows) {
    const { col, dir } = SORT;
    const v = r => r[col] ?? '';
    rows.sort((a, b) => v(a) < v(b) ? -dir : v(a) > v(b) ? dir : 0);
}

function renderFlagsHtml(r) {
    const parts = [];
    if (r._isSus)     parts.push('<span class="flag flag-sus">SUS</span>');
    if (r._isStarved) parts.push('<span class="flag flag-starved">STARVED</span>');
    if (r._isCap)     parts.push('<span class="flag flag-cap">CAP</span>');
    if (r._isVirt)    parts.push('<span class="flag flag-virt">VIRT</span>');
    if (r._isCons || /pattern_provider/i.test(r.item)) parts.push('<span class="flag flag-cons">CONS</span>');
    return parts.join('');
}

function renderTable() {
    const rows = filteredTableRows();
    sortRows(rows);
    const tb = byId('tbody');
    tb.innerHTML = '';
    for (const r of rows) {
        const tr = document.createElement('tr');
        tr.dataset.level = r.level;

        // Row tint — priority: SUS > STARVED > CAP > VIRT > CONS
        if      (r._isSus)     tr.classList.add('row-sus');
        else if (r._isStarved) tr.classList.add('row-starved');
        else if (r._isCap)     tr.classList.add('row-cap');
        else if (r._isVirt)    tr.classList.add('row-virt');
        else if (r._isCons)    tr.classList.add('row-cons');

        tr.oncontextmenu = ev => {
            ev.preventDefault();
            openCtx(ev.clientX, ev.clientY, { x: r.x, y: r.y, z: r.z, level: r.level, item: r.item });
        };
        tr.onclick = async () => {
            try { await navigator.clipboard.writeText(`/tp @s ${r.x} ${r.y} ${r.z}`); } catch {}
        };
        tr.innerHTML = `<td>${esc(r.level)}</td><td>${esc(r.item)}</td><td>${r.x}</td><td>${r.y}</td><td>${r.z}</td><td>${renderFlagsHtml(r)}</td>`;
        tb.appendChild(tr);
    }
    byId('count').textContent = `${rows.length} rows`;
}

/* ── 3D viewport ────────────────────────────────────────── */
let R = null, scene = null, camera = null, controls = null, raycaster = null;
let instanced = [], ringGroup = null, highlightObj = null, highlightExpire = 0, pendingNav = null;

function rendererResize() {
    if (!R) return;
    const wrap = byId('canvasWrap');
    const w = wrap.clientWidth || 1, h = wrap.clientHeight || 1;
    R.setSize(w, h, false);
    if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function focusCamera(rows) {
    if (!rows.length || !camera || !controls) return;
    let cand = rows.filter(r => !(r.x === 0 && r.y === 0 && r.z === 0));
    if (!cand.length) cand = rows.slice();
    const sx = cand.map(r => r.x).sort((a,b)=>a-b),
          sy = cand.map(r => r.y).sort((a,b)=>a-b),
          sz = cand.map(r => r.z).sort((a,b)=>a-b);
    const x5  = percentile(sx,.05), x95 = percentile(sx,.95),
          y5  = percentile(sy,.05), y95 = percentile(sy,.95),
          z5  = percentile(sz,.05), z95 = percentile(sz,.95);
    const trimmed = cand.filter(r => r.x>=x5&&r.x<=x95&&r.y>=y5&&r.y<=y95&&r.z>=z5&&r.z<=z95);
    const use = trimmed.length ? trimmed : cand;
    const xm = percentile(use.map(r=>r.x).sort((a,b)=>a-b),.5),
          ym = percentile(use.map(r=>r.y).sort((a,b)=>a-b),.5),
          zm = percentile(use.map(r=>r.z).sort((a,b)=>a-b),.5);
    const extent = Math.max(Math.abs(x95-x5)||16, Math.abs(y95-y5)||16, Math.abs(z95-z5)||16);
    const dist = Math.max(25, extent * 1.2);
    camera.position.set(xm + dist, ym + dist * 0.5, zm + dist);
    controls.target.set(xm, ym, zm);
    controls.update();
}

function flyTo(x, y, z) {
    if (!camera || !controls) return;
    camera.position.set(x + 15, y + 15, z + 15);
    controls.target.set(x, y, z);
    controls.update();
}

function addHighlight(x, y, z) {
    const s = Math.max(0.05, +byId('cubeSize').value || 0.35) * 1.35;
    const geom = new THREE.EdgesGeometry(new THREE.BoxGeometry(s, s, s));
    const mat  = new THREE.LineBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 1 });
    const mesh = new THREE.LineSegments(geom, mat);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    if (highlightObj) scene.remove(highlightObj);
    highlightObj    = mesh;
    highlightExpire = performance.now() + 20000;
    scene.add(highlightObj);
}

function addCategoryMeshes(rows, opacity) {
    const s    = Math.max(0.05, +byId('cubeSize').value || 0.35);
    const geom = new THREE.BoxGeometry(s, s, s);
    const defs = [
        { pred: r => r.item === 'ae2:cable_bus',                            color: 0xa78bfa },
        { pred: r => r._isCap,                                              color: 0xf472b6 },
        { pred: r => r._isVirt,                                             color: 0x38bdf8 },
        { pred: r => r._isCons || /pattern_provider/i.test(r.item),         color: 0x34d399 },
        { pred: r => r._isStarved,                                          color: 0xffb74d },
        // catch-all: any item not covered by the predicates above (energy cells, quantum
        // structural blocks, misc devices that don't use channels, etc.)
        { pred: r => r.item !== 'ae2:cable_bus' && !r._isCap && !r._isVirt && !r._isCons
                     && !r._isStarved && !/pattern_provider/i.test(r.item),  color: 0x64748b }
    ];
    for (const d of defs) {
        const items = rows.filter(d.pred);
        if (!items.length) continue;
        const mat  = new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity });
        const mesh = new THREE.InstancedMesh(geom, mat, items.length);
        const m4   = new THREE.Matrix4();
        for (let i = 0; i < items.length; i++) {
            const r = items[i];
            m4.makeTranslation(r.x + 0.5, r.y + 0.5, r.z + 0.5);
            mesh.setMatrixAt(i, m4);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.userData._rows = items;
        scene.add(mesh);
        instanced.push(mesh);
    }
}

function pickRowUnderMouse(ev) {
    if (!raycaster || !camera || !R || !instanced.length) return null;
    const rect = R.domElement.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width)  *  2 - 1;
    const my = -(((ev.clientY - rect.top)  / rect.height) * 2 - 1);
    raycaster.setFromCamera({ x: mx, y: my }, camera);
    let best = null;
    for (const mesh of instanced) {
        const inter = raycaster.intersectObject(mesh, true);
        if (!inter.length) continue;
        const hit = inter[0];
        const idx = hit.instanceId ?? -1;
        if (idx < 0 || !mesh.userData?._rows) continue;
        const row = mesh.userData._rows[idx];
        if (!row) continue;
        if (!best || hit.distance < best.distance) best = { distance: hit.distance, row };
    }
    return best ? best.row : null;
}

function build3D(fit = false) {
    const wrap = byId('canvasWrap');
    if (!R) {
        R = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        R.setClearColor(0x0a0f14, 1);
        wrap.appendChild(R.domElement);
    }
    rendererResize();

    scene    = new THREE.Scene();
    camera   = new THREE.PerspectiveCamera(60, (R.domElement.clientWidth || 1) / (R.domElement.clientHeight || 1), 0.1, 8000);
    camera.position.set(40, 32, 40);
    controls = new OrbitControls(camera, R.domElement);
    controls.enableDamping = true;
    raycaster = new THREE.Raycaster();

    // Grid floor — positioned slightly below data centroid
    const grid = new THREE.GridHelper(800, 80, 0x0a1a28, 0x081420);
    grid.position.y = -1;
    scene.add(grid);

    const f          = readFilters();
    const dimSel     = byId('dim3d').value || SELECTED_DIM;
    const allRowsDim = RECORDS.filter(r => r.level === dimSel && nsAllowed(r.item)).filter(r => f.showBL || !blMatches(r.item));
    const rowsAll    = filteredTableRows();
    const rowsMatch  = rowsAll.filter(r => r.level === dimSel);
    const rowsNon    = allRowsDim.filter(r => !rowsMatch.includes(r));
    const filtersActive = isFilterActive(), showContext = byId('showContext').checked;

    byId('overlay').textContent = `${filtersActive ? '3D (filtered)' : '3D'}: ${dimSel ?? '(none)'} — ${allRowsDim.length} items`;

    instanced  = [];
    ringGroup  = new THREE.Group();
    highlightObj = null;

    if (filtersActive) {
        if (showContext && rowsNon.length) addCategoryMeshes(rowsNon, GHOST_OPACITY);
        if (rowsMatch.length) addCategoryMeshes(rowsMatch, 1.0);
    } else {
        if (allRowsDim.length) addCategoryMeshes(allRowsDim, UNFILTERED_OPACITY);
    }

    const s   = Math.max(0.05, +byId('cubeSize').value || 0.35);
    const sus = (filtersActive ? rowsMatch : allRowsDim).filter(r => r.item === 'ae2:cable_bus' && r._isSus);
    if (sus.length) {
        const rgeom = new THREE.TorusGeometry(s * 0.8, s * 0.12, 8, 24);
        const rmat  = new THREE.MeshBasicMaterial({ color: 0xf87171, transparent: true, opacity: filtersActive ? 1 : 0.75 });
        for (const r of sus) {
            const m = new THREE.Mesh(rgeom, rmat);
            m.position.set(r.x + 0.5, r.y + 0.5, r.z + 0.5);
            m.rotation.x = Math.PI / 2;
            ringGroup.add(m);
        }
        scene.add(ringGroup);
    }

    if (fit) focusCamera(rowsMatch.length ? rowsMatch : allRowsDim);
    if (pendingNav) {
        flyTo(pendingNav.x, pendingNav.y, pendingNav.z);
        addHighlight(pendingNav.x, pendingNav.y, pendingNav.z);
        pendingNav = null;
    }

    const tip    = byId('tooltip');
    const canvas = R.domElement;

    canvas.onmousemove = ev => {
        const rect = canvas.getBoundingClientRect();
        const mx = ((ev.clientX - rect.left) / rect.width)  *  2 - 1;
        const my = -(((ev.clientY - rect.top)  / rect.height) * 2 - 1);
        raycaster.setFromCamera({ x: mx, y: my }, camera);
        const hits = [];
        for (const mesh of instanced) {
            const inter = raycaster.intersectObject(mesh, true);
            if (!inter.length) continue;
            const idx = inter[0].instanceId ?? -1;
            if (idx >= 0 && mesh.userData._rows?.[idx]) hits.push(mesh.userData._rows[idx]);
        }
        if (hits.length) {
            const uniq = [...new Set(hits.map(h => h.item))];
            tip.style.display = 'block';
            tip.style.left    = (ev.clientX + 14) + 'px';
            tip.style.top     = (ev.clientY + 14) + 'px';
            const { x: nx, y: ny, z: nz } = hits[0];
            tip.innerHTML = `<strong>(${nx}, ${ny}, ${nz})</strong><br/>${uniq.slice(0, 10).map(esc).join('<br/>')}${uniq.length > 10 ? '<br/>…' : ''}`;
        } else {
            tip.style.display = 'none';
        }
    };
    canvas.onmouseleave = () => { tip.style.display = 'none'; };

    canvas.addEventListener('contextmenu', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const row = pickRowUnderMouse(ev);
        if (!row) return;
        openCtx(ev.clientX, ev.clientY, { x: row.x, y: row.y, z: row.z, level: row.level, item: row.item });
    }, { capture: true });

    R.setAnimationLoop(() => {
        if (highlightObj) {
            const t    = performance.now();
            const base = 0.4 + 0.4 * Math.sin(t / 250);
            const fade = highlightExpire - t;
            if (fade <= 0) {
                scene.remove(highlightObj);
                highlightObj = null;
            } else {
                highlightObj.material.opacity    = 0.3 + 0.5 * base;
                highlightObj.material.needsUpdate = true;
            }
        }
        controls.update();
        R.render(scene, camera);
    });
}

/* ── Sort indicators ────────────────────────────────────── */
function renderSortIndicators() {
    for (const th of document.querySelectorAll('thead th[data-col]')) {
        const s = th.querySelector('.sort-ind') || (() => {
            const x = document.createElement('span');
            x.className = 'sort-ind';
            th.appendChild(x);
            return x;
        })();
        s.textContent = (SORT.col === th.dataset.col) ? (SORT.dir > 0 ? '▲' : '▼') : '⇅';
    }
}

function renderAll() {
    renderBlacklist();
    renderNonConsumers();
    renderWhitelist();
    renderSortIndicators();
    renderTable();
    build3D(true);
}

/* ── Filter panel collapse ──────────────────────────────── */
function setControlsCollapsed(c) {
    const wrap = byId('controlsWrap');
    const chev = byId('toggleChev');
    const txt  = byId('toggleText');
    if (c) {
        wrap.classList.add('collapsed');
        chev.style.transform = 'rotate(180deg)';
        txt.textContent = 'Show filters';
    } else {
        wrap.classList.remove('collapsed');
        chev.style.transform = 'rotate(0deg)';
        txt.textContent = 'Hide filters';
    }
    saveBool(LS.collapsed, c);
    setTimeout(() => rendererResize(), 260);
}

/* ── Context menu ───────────────────────────────────────── */
let ctxPayload = null;

function openCtx(x, y, payload) {
    ctxPayload = payload;
    const m = byId('ctx');
    m.style.display = 'block';
    const w = m.offsetWidth || 200, h = m.offsetHeight || 120;
    m.style.left = Math.min(x, innerWidth  - w - 4) + 'px';
    m.style.top  = Math.min(y, innerHeight - h - 4) + 'px';
}

function closeCtx() { byId('ctx').style.display = 'none'; ctxPayload = null; }

/* ── Defaults reset ─────────────────────────────────────── */
function resetControlsToDefaults(keepLists = false) {
    byId('fLevel').value = '';
    byId('fItem').value  = '';
    byId('fXmin').value  = ''; byId('fXmax').value = '';
    byId('fYmin').value  = ''; byId('fYmax').value = '';
    byId('fZmin').value  = ''; byId('fZmax').value = '';
    byId('fFlags').value = 'any';
    byId('cubeSize').value = '0.35';
    byId('showContext').checked = true;
    byId('virtHeuristic').checked = true;
    byId('cfgSimple').value   = '8';
    byId('cfgDense').value    = '32';
    byId('cfgP2P').value      = '32';
    byId('cfgWireless').value = '32';
    byId('showBL').checked = true;
    saveBool(LS.showBL, true);
    if (!keepLists) {
        BLACKLIST = [];
        saveArr(LS.blacklist, BLACKLIST);
        NON_CONSUMERS = ['extendedae:ex_inscriber', 'advanced_ae:reaction_chamber'];
        saveArr(LS.nonConsumers, NON_CONSUMERS);
        WL_LIST = ['ae2', 'megacells', 'ae2things', 'appflux', 'aeinfinitybooster', 'ae2wtlib', 'extendedae', 'ae2networkanalyser', 'advanced_ae'];
        saveArr(LS.whitelist, WL_LIST);
        WL_ENABLED = false;
        byId('wlEnabled').checked = false;
        saveBool(LS.wlEnabled, false);
    }
    computeSuspect();
    renderAll();
}

/* ── Drag-resize split handle ───────────────────────────── */
function initSplitDrag() {
    const splitEl  = byId('split');
    const rightEl  = byId('right');
    const workEl   = byId('work');
    let dragging = false, startY = 0, startH = 0;

    splitEl.addEventListener('mousedown', e => {
        dragging = true;
        startY   = e.clientY;
        startH   = rightEl.clientHeight;
        splitEl.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    addEventListener('mousemove', e => {
        if (!dragging) return;
        const delta  = e.clientY - startY;
        const workH  = workEl.clientHeight;
        const newH   = Math.max(200, Math.min(workH - 160, startH + delta));
        rightEl.style.flex = `0 0 ${newH}px`;
        rendererResize();
    });

    addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        splitEl.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
}

/* ── Boot ───────────────────────────────────────────────── */
addEventListener('load', () => {
    setControlsCollapsed(loadBool(LS.collapsed, false));
    byId('showBL').checked = loadBool(LS.showBL, true);
    renderBlacklist();
    renderNonConsumers();
    renderWhitelist();
    renderSortIndicators();
    initSplitDrag();

    // Single resize listener
    addEventListener('resize', () => rendererResize());

    /* ── Toggle filter panel ── */
    byId('toggleCtl').onclick = () => {
        setControlsCollapsed(!byId('controlsWrap').classList.contains('collapsed'));
    };

    /* ── Legend ── */
    byId('legendBtn').onclick = () => {
        const p    = byId('legend');
        const open = p.style.display !== 'block';
        p.style.display = open ? 'block' : 'none';
        const chev = byId('legendBtn').querySelector('.legend-chev');
        if (chev) chev.style.transform = open ? 'rotate(180deg)' : '';
    };

    /* ── File load ── */
    byId('files').onchange = async e => {
        if (e.target.files?.length) await loadFiles([...e.target.files]);
    };

    /* ── Clear / Unload (shared logic) ── */
    const unloadData = () => {
        RAW = []; RECORDS = []; DIMENSIONS = []; SELECTED_DIM = null; FACE_PARTS = new Map();
        byId('dim3d').innerHTML = '';
        byId('tbody').innerHTML = '';
        byId('count').textContent = '0 rows';
        byId('overlay').textContent = '';
        byId('emptyState').classList.remove('hidden');
        byId('unloadRow').classList.remove('visible');
        const cw = byId('canvasWrap');
        cw.innerHTML = '';
        if (R) { try { R.dispose?.(); } catch {} }
        R = scene = camera = controls = raycaster = null;
        instanced = []; ringGroup = null; highlightObj = null;
        byId('files').value = '';
        build3D(true);
    };

    byId('btnUnload').onclick = unloadData;

    byId('btnClear').onclick = () => {
        unloadData();
    };

    /* ── Reset ── */
    byId('btnReset').onclick = () => resetControlsToDefaults(true);

    /* ── Blacklist ── */
    byId('blAdd').onclick = () => {
        const v = (byId('blInput').value || '').trim().toLowerCase();
        if (!v) return;
        if (!/^[a-z0-9_.-]+:\*|[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(v)) { alert('Use "mod:*" or "mod:item"'); return; }
        if (!BLACKLIST.includes(v)) BLACKLIST.push(v);
        saveArr(LS.blacklist, BLACKLIST);
        byId('blInput').value = '';
        computeSuspect(); renderAll();
    };
    byId('showBL').onchange = () => { saveBool(LS.showBL, byId('showBL').checked); renderAll(); };

    /* ── Non-consumers ── */
    byId('ncAdd').onclick = () => {
        const v = (byId('ncInput').value || '').trim().toLowerCase();
        if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(v)) { alert('Use "mod:item"'); return; }
        if (!NON_CONSUMERS.includes(v)) NON_CONSUMERS.push(v);
        saveArr(LS.nonConsumers, NON_CONSUMERS);
        byId('ncInput').value = '';
        computeSuspect(); renderAll();
    };

    /* ── Whitelist ── */
    byId('wlAdd').onclick = () => {
        const ns = (byId('wlInput').value || '').trim();
        if (!/^[a-z0-9_.-]+$/i.test(ns)) { alert('Enter a namespace only'); return; }
        if (!WL_LIST.includes(ns)) WL_LIST.push(ns);
        saveArr(LS.whitelist, WL_LIST);
        byId('wlInput').value = '';
        renderWhitelist(); renderAll();
    };
    byId('wlEnabled').onchange = () => {
        WL_ENABLED = byId('wlEnabled').checked;
        saveBool(LS.wlEnabled, WL_ENABLED);
        renderAll();
    };

    /* ── Live filter inputs ── */
    const liveIds = ['fLevel','fItem','fXmin','fXmax','fYmin','fYmax','fZmin','fZmax','fFlags',
                     'cubeSize','cfgSimple','cfgDense','cfgP2P','cfgWireless','virtHeuristic','showContext'];
    for (const id of liveIds) {
        byId(id).addEventListener('input',  debounce(() => { computeSuspect(); renderTable(); build3D(true); }, 100));
        byId(id).addEventListener('change', ()           => { computeSuspect(); renderTable(); build3D(true); });
    }

    /* ── Sort column headers ── */
    for (const th of document.querySelectorAll('thead th[data-col]')) {
        th.onclick = () => {
            const c = th.dataset.col;
            SORT.col === c ? SORT.dir = -SORT.dir : (SORT.col = c, SORT.dir = 1);
            renderSortIndicators();
            renderTable();
            build3D(true);
        };
    }

    /* ── Dimension selector ── */
    byId('dim3d').onchange = () => { SELECTED_DIM = byId('dim3d').value || null; build3D(true); };

    /* ── Go to block ── */
    byId('gotoBtn').onclick = () => {
        const x = +byId('gotoX').value, y = +byId('gotoY').value, z = +byId('gotoZ').value;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        flyTo(x, y, z);
        addHighlight(x, y, z);
    };

    /* ── Context menu actions ── */
    byId('ctx').addEventListener('click', async e => {
        if (!(e.target instanceof HTMLElement)) return;
        const act = e.target.getAttribute('data-action');
        if (!act || !ctxPayload) return;
        const { x, y, z, level, item } = ctxPayload;
        if (act === 'goto') {
            const cur = byId('dim3d').value || SELECTED_DIM;
            if (cur !== level) {
                SELECTED_DIM = level;
                byId('dim3d').value = level;
                pendingNav = { x, y, z };
                build3D(true);
            } else {
                flyTo(x, y, z);
                addHighlight(x, y, z);
            }
        }
        if (act === 'filter-item') { byId('fItem').value = item || ''; renderTable(); build3D(true); }
        if (act === 'copy-coords') { try { await navigator.clipboard.writeText(`${x} ${y} ${z}`); } catch {} }
        if (act === 'copy-tp')     { try { await navigator.clipboard.writeText(`/tp @s ${x} ${y} ${z}`); } catch {} }
        closeCtx();
    });

    addEventListener('click',   e => { if (e.target !== byId('ctx')) closeCtx(); });
    addEventListener('scroll',  closeCtx, true);
    addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeCtx();
            byId('helpOverlay').classList.remove('open');
        }
    });

    /* ── Copyable command snippets ── */
    document.addEventListener('click', async e => {
        const el = e.target.closest('.cmd-copy');
        if (!el) return;
        const cmd = el.dataset.cmd || el.textContent.trim();
        try {
            await navigator.clipboard.writeText(cmd);
            el.classList.add('copied');
            const orig = el.textContent;
            el.textContent = '✓ Copied!';
            setTimeout(() => { el.textContent = orig; el.classList.remove('copied'); }, 1800);
        } catch { /* clipboard unavailable */ }
    });

    /* ── Help modal ── */
    const openHelp  = () => byId('helpOverlay').classList.add('open');
    const closeHelp = () => byId('helpOverlay').classList.remove('open');
    byId('helpBtn').onclick      = openHelp;
    byId('helpBtnEmpty').onclick = openHelp;
    byId('helpClose').onclick    = closeHelp;
    byId('helpOverlay').addEventListener('click', e => {
        if (e.target === byId('helpOverlay')) closeHelp();
    });

    // Initial 3D build (empty scene)
    build3D(true);
});
