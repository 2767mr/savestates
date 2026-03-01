import { Injectable, Mod, terra } from '@project-selene/api';
import { CONTROL_MAP, ControlConfig, g_control, g_storage, Game, KEY, SaveFile, TeleportManager, Vec2, Vec3 } from '@project-selene/api/terra';


const STATE_ID = '__savestate';
const META_KEY = '__seleneSavestateMeta';


async function saveState() {
    if (g_storage.saving || g_storage.savingSystem) {
        return; // avoid racing normal save
    }

    const activeMap = terra.g_game?.map?.active;
    if (!activeMap) {
        console.warn("No active map found, not saving savestate");
        return;
    }

    const meta = {
        t: Date.now(),
        marker: {
            map: terra.g_game?.lastLoadedMapName || null,
            pos: terra.g_player?.entity?.core?.pos?.getArray?.() || null,
            face: terra.g_player?.entity?.core?.getFaceDir()?.getArray?.() || null,
        },
    };

    const data: Record<string, any> = {};
    g_storage.assembleSaveData(data);

    data.meta ||= {};
    data.meta[META_KEY] = meta;

    const file = new SaveFile(STATE_ID, data, g_storage.slotPaths);
    await file.saveData();
}

async function loadState() {
    const tmp = new SaveFile(STATE_ID, {}, g_storage.slotPaths);
    const data = await tmp.loadData();
    const pendingMeta = data?.meta?.[META_KEY] || null;
    if (pendingMeta) {
        forceReplaceMap = {
            map: pendingMeta.marker.map,
            marker: '',
            isPos: true,
            pos: (Vec3 as any).fromArray(pendingMeta.marker.pos),
            face: (Vec2 as any).fromArray(pendingMeta.marker.face),
        }
    }

    g_storage.load(STATE_ID);

    if (forceReplaceMap) {
        console.warn("Force replace map was not applied, something probably went wrong with loading the savestate.");
        forceReplaceMap = null;
    }
}

let forceReplaceMap: {
    map: string;
    marker: '';
    isPos: true;
    pos: unknown; //Vec3
    face: unknown; //Vec2
} | null = null;
class ForceReplaceMap extends Injectable(TeleportManager) {
    startTeleport() {
        if (forceReplaceMap) {
            this.next.set(forceReplaceMap);
            forceReplaceMap = null;
        }
        super.startTeleport();
    }
}


class Hotkeys extends Injectable(Game) {
    update() {
        super.update();

        if (terra.INPUT_ACTIONS['savestates-mod-save']?.hasStarted()) {
            saveState().catch(() => { });
        }
        if (terra.INPUT_ACTIONS['savestates-mod-load']?.hasStarted()) {
            loadState().catch(() => { });
        }
    }
}


export default function main(mod: Mod) {
    mod.inject(Hotkeys);
    mod.inject(ForceReplaceMap);

    CONTROL_MAP.PC["savestates-mod-save"] = new ControlConfig({
        key1: KEY.K,
        group: "DEFAULT",
    });
    CONTROL_MAP.PC["savestates-mod-load"] = new ControlConfig({
        key1: KEY.L,
        group: "DEFAULT",
    });
    g_control.build();
}
