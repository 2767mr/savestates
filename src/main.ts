import { Injectable, Mod, terra } from '@project-selene/api';
import { CONTROL_MAP, ControlConfig, g_storage, Game, KEY, SaveFile } from '@project-selene/api/terra';

// Savestates for Alabaster Dawn via Project Selene
// Single-slot emulator-style savestate.
// Hotkeys: K = save, L = load
// Suppresses F6/F7/F8 (some builds crash on bug-report hotkeys).
// Stores meta inside save file data.meta.__seleneSavestateMeta.
// Restores position using core.setPosC (collision-aware).

const STATE_ID = '__savestate';
const META_KEY = '__seleneSavestateMeta';

function applyPosition(meta: Record<string, any>) {
    const core = terra.g_player?.entity?.core;
    const arr = meta?.posArr;
    if (!core || !arr)
        return false;
    return !!core.pos?.setObject?.(arr);
}


// load monitoring
let loadInProgress = false;
let loadStartedAt = 0;
let forcedMapOnce = false;
let rafHandle: number | null = null;
let finishTimer: number | null = null;


async function saveState() {
    if (!g_storage || !SaveFile)
        throw new Error('Missing g_storage or SaveFile');

    if (g_storage.saving || g_storage.savingSystem)
        return; // avoid racing normal save


    const activeMap = terra.g_game?.map?.active;

    const meta = {
        t: Date.now(),
        mapName: terra.g_game?.lastLoadedMapName || null,
        posArr: terra.g_player?.entity?.core?.pos?.getArray?.(),
        mapInfo: activeMap ? {
            name: activeMap.name,
            path: activeMap.path,
            id: activeMap.id,
            uid: activeMap.uid,
            room: activeMap.room,
            roomName: activeMap.roomName,
            mapName: activeMap.mapName,
        } : {}
    };

    const data: Record<string, any> = {};
    g_storage.assembleSaveData(data);
    data.meta ||= {};
    data.meta[META_KEY] = meta;

    const file = new SaveFile(STATE_ID, data, g_storage.slotPaths);
    await file.saveData();
}

function loadState() {
    if (!g_storage || !SaveFile) throw new Error('Missing g_storage or SaveFile');

    if (loadInProgress) {
        const age = Date.now() - loadStartedAt;
        if (age <= 6000) return; // ignore repeated presses briefly
        clearLoad(); // stuck, allow retry
    }

    loadInProgress = true;
    loadStartedAt = Date.now();
    forcedMapOnce = false;

    finishTimer = setTimeout(() => { if (loadInProgress) clearLoad(); }, 9000);

    readAndApplyMeta().catch(() => clearLoad());
}


async function readAndApplyMeta() {
    const tmp = new SaveFile(STATE_ID, {}, g_storage.slotPaths);
    const data = await tmp.loadData();
    const pendingMeta = data?.meta?.[META_KEY] || null;
    g_storage.load(STATE_ID);

    let f = 0;
    const tick = () => {
        if (!loadInProgress)
            return;

        const active = terra.g_game?.map?.active?.path;
        const want = pendingMeta?.mapName;

        if (want && !forcedMapOnce && f >= 2 && active !== want) {
            forcedMapOnce = true;
            try { terra.g_game?.loadMap?.(want); } catch { }
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

function clearLoad() {
    loadInProgress = false;
    forcedMapOnce = false;
    loadStartedAt = 0;
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
}

class Hotkeys extends Injectable(Game) {
    update() {
        super.update();

        if (terra.INPUT_ACTIONS['savestates-mod-save']?.hasStarted() || terra.INPUT_ACTIONS['savestates-mod-save']?.hasEnded()) {
            saveState().catch(() => { });
        }
        if (terra.INPUT_ACTIONS['savestates-mod-load']?.hasStarted() || terra.INPUT_ACTIONS['savestates-mod-load']?.hasEnded()) {
            try { loadState(); } catch { }
        }
    }
}


export default function main(mod: Mod) {
    mod.inject(Hotkeys);

    CONTROL_MAP.PC["savestates-mod-save"] = new ControlConfig({
        key1: KEY.K,
        group: "DEFAULT",
    });
    CONTROL_MAP.PC["savestates-mod-load"] = new ControlConfig({
        key1: KEY.L,
        group: "DEFAULT",
    });
}

export function unload() {
    clearLoad();
}
