import { Mod } from '@project-selene/api';
import { SaveFile } from '@project-selene/api/terra';

// Savestates for Alabaster Dawn via Project Selene
// Single-slot emulator-style savestate.
// Hotkeys: K = save, L = load
// Suppresses F6/F7/F8 (some builds crash on bug-report hotkeys).
// Stores meta inside save file data.meta.__seleneSavestateMeta.
// Restores position using core.setPosC (collision-aware).

const STATE_ID = '__savestate';
const META_KEY = '__seleneSavestateMeta';

function selene() { return (globalThis as any).__projectSelene; }
function getConst(name: string) { return selene()?.consts?.[name]; }
function getLetValue(name: string) {
    const w = selene()?.lets?.[name];
    try { if (w && typeof w.getter === 'function') return w.getter(); } catch { }
    return w;
}
function getStorage() { return getConst('g_storage') || getLetValue('g_storage'); }

function findSaveFileClass() {
    const s = selene();
    const direct = SaveFile;;
    if (direct && typeof direct === 'function') return direct;

    for (const pool of [s?.consts, s?.classes]) {
        if (!pool) continue;
        for (const v of Object.values(pool)) {
            if (typeof v === 'function' && v.prototype && typeof v.prototype.saveData === 'function') return v;
        }
    }
    return null;
}

function isTypingTarget(t: unknown) {
    return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function vecToArr(v: any) {
    if (!v) return null;
    if (Array.isArray(v)) return v.slice(0, 3);
    if (Array.isArray(v.v)) return v.v.slice(0, 3);
    if (typeof v.x === 'number' && typeof v.y === 'number') return [v.x, v.y, typeof v.z === 'number' ? v.z : 0];
    return null;
}

function getGame() { return getLetValue('g_game'); }
function getMapName() {
    const g = getGame();
    return g?.lastLoadedMapName || g?.map?.active?.path || g?.map?.active?.name || null;
}
function getMapInfo() {
    const g = getGame();
    const a = g?.map?.active;
    const info: Record<string, unknown> = {};
    if (a) {
        for (const k of ['name', 'path', 'id', 'uid', 'room', 'roomName', 'mapName']) {
            if (a[k] != null) info[k] = a[k];
        }
    }
    return info;
}
function getPlayer() { return getLetValue('g_player'); }
function getPlayerCore() {
    const p = getPlayer();
    return p?.entity?.core || p?.sub?.entity?.core || null;
}

function applyPosition(meta: any) {
    const core = getPlayerCore();
    const arr = meta?.posArr;
    if (!core || !arr) return false;
    const [x, y, z] = arr;

    if (typeof core.setPosC === 'function') {
        // setPosC(x,y,z, keepActorState=true, keepVel=false)
        core.setPosC(x, y, z, true, false);
        return true;
    }
    if (core.pos && typeof core.pos.setC === 'function') {
        core.pos.setC(x, y, z);
        return true;
    }
    if (core.pos) {
        if (Array.isArray(core.pos.v)) { core.pos.v[0] = x; core.pos.v[1] = y; core.pos.v[2] = z; }
        try { core.pos.x = x; core.pos.y = y; core.pos.z = z; } catch { }
        return true;
    }
    return false;
}

async function readMeta(storage: any, SaveFile: any) {
    const tmp = new SaveFile(STATE_ID, {}, storage.slotPaths);
    if (typeof tmp.loadData === 'function') {
        const r = await tmp.loadData();
        const data = r || tmp.data || tmp;
        return data?.meta?.[META_KEY] || tmp.data?.meta?.[META_KEY] || null;
    }
    return null;
}

// load monitoring
let loadInProgress = false;
let loadStartedAt = 0;
let pendingMeta = null;
let forcedMapOnce = false;
let rafHandle = null;
let finishTimer = null;

function clearLoad() {
    loadInProgress = false;
    pendingMeta = null;
    forcedMapOnce = false;
    loadStartedAt = 0;
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
}

async function saveState() {
    const storage = getStorage();
    const SaveFile = findSaveFileClass();
    if (!storage || !SaveFile) throw new Error('Missing g_storage or SaveFile');

    if (storage.saving || storage.savingSystem) return; // avoid racing normal save

    const core = getPlayerCore();
    const meta = {
        t: Date.now(),
        mapName: getMapName(),
        posArr: vecToArr(core?.pos),
        mapInfo: getMapInfo()
    };

    const data = {};
    storage.assembleSaveData(data);
    data.meta = data.meta || {};
    data.meta[META_KEY] = meta;

    const file = new SaveFile(STATE_ID, data, storage.slotPaths);
    await file.saveData();
}

function monitorLoad() {
    let f = 0;
    const tick = () => {
        if (!loadInProgress) return;

        const game = getGame();
        const active = game?.map?.active?.path || game?.map?.active?.name;
        const want = pendingMeta?.mapName;

        if (want && !forcedMapOnce && f >= 2 && active && active !== want) {
            forcedMapOnce = true;
            try { game?.loadMap?.(want); } catch { }
        }

        const mapOk = !want || active === want;
        if (pendingMeta?.posArr && mapOk) {
            // apply a few times to beat late placement
            if (f === 2 || f === 6 || f === 12 || f === 18) applyPosition(pendingMeta);
            if (f >= 24) { clearLoad(); return; }
        }

        if (f >= 240) { clearLoad(); return; }
        f++;
        rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);
}

function loadState() {
    const storage = getStorage();
    const SaveFile = findSaveFileClass();
    if (!storage || !SaveFile) throw new Error('Missing g_storage or SaveFile');

    if (loadInProgress) {
        const age = Date.now() - loadStartedAt;
        if (age <= 6000) return; // ignore repeated presses briefly
        clearLoad(); // stuck, allow retry
    }

    loadInProgress = true;
    loadStartedAt = Date.now();
    forcedMapOnce = false;

    finishTimer = setTimeout(() => { if (loadInProgress) clearLoad(); }, 9000);

    (async () => {
        pendingMeta = await readMeta(storage, SaveFile);
        storage.load(STATE_ID);
        monitorLoad();
    })().catch(() => clearLoad());
}

function installHotkeys() {
    const handler = (e) => {
        // suppress crashy keys always
        if (e.code === 'F6' || e.code === 'F7' || e.code === 'F8') {
            e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
            return;
        }

        if (e.repeat) return;
        if (isTypingTarget(e.target)) return;

        // K save, L load
        if (e.code === 'KeyK') {
            e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
            saveState().catch(() => { });
            return;
        }
        if (e.code === 'KeyL') {
            e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
            try { loadState(); } catch { }
            return;
        }
    };

    // Capture phase for reliability
    document.addEventListener('keydown', handler, true);
    window.addEventListener('keydown', handler, true);
    document.addEventListener('keyup', handler, true);
    window.addEventListener('keyup', handler, true);
}

export default function main(mod: Mod) {
    // best-effort init
    installHotkeys();
}

export function unload() {
    clearLoad();
}
