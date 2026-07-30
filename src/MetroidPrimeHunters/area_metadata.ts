import { assert } from '../util.js';
import { MPHEntityMetadata } from './entity.js';

// The extractor tool writes every metadata table the viewer needs into one file.
export interface MPHMetadata {
    areas: readonly MPHAreaMetadata[];
    entities: MPHEntityMetadata;
    // Archive stem to the texture file its models share, and model filename to
    // the archive holding it.
    archiveTextures: Record<string, string>;
    modelArchives: Record<string, string>;
}

export interface MPHAreaFog {
    enabled: boolean;
    color: number;
    depthShift: number;
    offset: number;
}

export interface MPHAreaMetadata {
    sourceAddress: number;
    geometrySet?: number;
    name: string;
    modelFilename: string;
    animationFilename: string;
    textureFilename: string;
    collisionFilename: string;
    entityFilename: string;
    nodeFilename: string;
    fog: MPHAreaFog;
    lightColor0: readonly number[];
    lightVector0: readonly number[];
    lightColor1: readonly number[];
    lightVector1: readonly number[];
}

// Generated from the LevelInfo and connector-vector tables used by PlaceAndLoadAdjacentLevelThroughDoor.
export interface MPHConnectorMetadata {
    id: number;
    name: string;
    modelFilename: string;
    animationFilename: string;
    collisionFilename: string;
    archiveName: string;
    displacement: readonly [number, number, number];
}

export const connectorMetadata: readonly MPHConnectorMetadata[] = [
    { id: 0, name: 'UNIT1_CX', modelFilename: 'unit1_CX_Model.bin', animationFilename: 'unit1_CX_Anim.bin', collisionFilename: 'unit1_CX_Collision.bin', archiveName: 'unit1_CX', displacement: [10, 0, 0] },
    { id: 1, name: 'UNIT1_CX', modelFilename: 'unit1_CX_Model.bin', animationFilename: 'unit1_CX_Anim.bin', collisionFilename: 'unit1_CX_Collision.bin', archiveName: 'unit1_CX', displacement: [10, 0, 0] },
    { id: 2, name: 'UNIT1_CZ', modelFilename: 'unit1_CZ_Model.bin', animationFilename: 'unit1_CZ_Anim.bin', collisionFilename: 'unit1_CZ_Collision.bin', archiveName: 'unit1_CZ', displacement: [0, 0, 10] },
    { id: 3, name: 'UNIT1_CZ', modelFilename: 'unit1_CZ_Model.bin', animationFilename: 'unit1_CZ_Anim.bin', collisionFilename: 'unit1_CZ_Collision.bin', archiveName: 'unit1_CZ', displacement: [0, 0, 10] },
    { id: 4, name: 'UNIT1_MORPH_CX', modelFilename: 'unit1_morph_CX_Model.bin', animationFilename: 'unit1_morph_CX_Anim.bin', collisionFilename: 'unit1_morph_CX_Collision.bin', archiveName: 'unit1_morph_CX', displacement: [10, 0, 0] },
    { id: 5, name: 'UNIT1_MORPH_CX', modelFilename: 'unit1_morph_CX_Model.bin', animationFilename: 'unit1_morph_CX_Anim.bin', collisionFilename: 'unit1_morph_CX_Collision.bin', archiveName: 'unit1_morph_CX', displacement: [10, 0, 0] },
    { id: 6, name: 'UNIT1_MORPH_CZ', modelFilename: 'unit1_morph_CZ_Model.bin', animationFilename: 'unit1_morph_CZ_Anim.bin', collisionFilename: 'unit1_morph_CZ_Collision.bin', archiveName: 'unit1_morph_CZ', displacement: [0, 0, 10] },
    { id: 7, name: 'UNIT1_MORPH_CZ', modelFilename: 'unit1_morph_CZ_Model.bin', animationFilename: 'unit1_morph_CZ_Anim.bin', collisionFilename: 'unit1_morph_CZ_Collision.bin', archiveName: 'unit1_morph_CZ', displacement: [0, 0, 10] },
    { id: 8, name: 'UNIT2_CX', modelFilename: 'unit2_CX_Model.bin', animationFilename: 'unit2_CX_Anim.bin', collisionFilename: 'unit2_CX_Collision.bin', archiveName: 'unit2_CX', displacement: [10.378662109375, 0, 0] },
    { id: 9, name: 'UNIT2_CX', modelFilename: 'unit2_CX_Model.bin', animationFilename: 'unit2_CX_Anim.bin', collisionFilename: 'unit2_CX_Collision.bin', archiveName: 'unit2_CX', displacement: [10.378662109375, 0, 0] },
    { id: 10, name: 'UNIT2_CZ', modelFilename: 'unit2_CZ_Model.bin', animationFilename: 'unit2_CZ_Anim.bin', collisionFilename: 'unit2_CZ_Collision.bin', archiveName: 'unit2_CZ', displacement: [0, 0, 10.378662109375] },
    { id: 11, name: 'UNIT2_CZ', modelFilename: 'unit2_CZ_Model.bin', animationFilename: 'unit2_CZ_Anim.bin', collisionFilename: 'unit2_CZ_Collision.bin', archiveName: 'unit2_CZ', displacement: [0, 0, 10.378662109375] },
    { id: 12, name: 'UNIT3_CX', modelFilename: 'unit3_CX_Model.bin', animationFilename: 'unit3_CX_Anim.bin', collisionFilename: 'unit3_CX_Collision.bin', archiveName: 'unit3_CX', displacement: [10, 0, 0] },
    { id: 13, name: 'UNIT3_CX', modelFilename: 'unit3_CX_Model.bin', animationFilename: 'unit3_CX_Anim.bin', collisionFilename: 'unit3_CX_Collision.bin', archiveName: 'unit3_CX', displacement: [10, 0, 0] },
    { id: 14, name: 'UNIT3_CZ', modelFilename: 'unit3_CZ_Model.bin', animationFilename: 'unit3_CZ_Anim.bin', collisionFilename: 'unit3_CZ_Collision.bin', archiveName: 'unit3_CZ', displacement: [0, 0, 10] },
    { id: 15, name: 'UNIT3_CZ', modelFilename: 'unit3_CZ_Model.bin', animationFilename: 'unit3_CZ_Anim.bin', collisionFilename: 'unit3_CZ_Collision.bin', archiveName: 'unit3_CZ', displacement: [0, 0, 10] },
    { id: 16, name: 'UNIT4_CX', modelFilename: 'unit4_CX_Model.bin', animationFilename: 'unit4_CX_Anim.bin', collisionFilename: 'unit4_CX_Collision.bin', archiveName: 'unit4_CX', displacement: [10, 0, 0] },
    { id: 17, name: 'UNIT4_CX', modelFilename: 'unit4_CX_Model.bin', animationFilename: 'unit4_CX_Anim.bin', collisionFilename: 'unit4_CX_Collision.bin', archiveName: 'unit4_CX', displacement: [10, 0, 0] },
    { id: 18, name: 'UNIT4_CZ', modelFilename: 'unit4_CZ_Model.bin', animationFilename: 'unit4_CZ_Anim.bin', collisionFilename: 'unit4_CZ_Collision.bin', archiveName: 'unit4_CZ', displacement: [0, 0, 10] },
    { id: 19, name: 'UNIT4_CZ', modelFilename: 'unit4_CZ_Model.bin', animationFilename: 'unit4_CZ_Anim.bin', collisionFilename: 'unit4_CZ_Collision.bin', archiveName: 'unit4_CZ', displacement: [0, 0, 10] },
    { id: 20, name: 'CYLINDER_C1', modelFilename: 'Cylinder_C1_model.bin', animationFilename: 'Cylinder_C1_anim.bin', collisionFilename: 'Cylinder_C1_collision.bin', archiveName: 'Cylinder_C1_CZ', displacement: [0, 2.295166015625, 22.654052734375] },
    { id: 21, name: 'BIGEYE_C1', modelFilename: 'BigEye_C1_model.bin', animationFilename: 'BigEye_C1_anim.bin', collisionFilename: 'BigEye_C1_collision.bin', archiveName: 'BigEye_C1_CZ', displacement: [0, -1.869873046875, 22.65380859375] },
    { id: 22, name: 'UNIT1_RM1_CX', modelFilename: 'unit1_RM1_CX_Model.bin', animationFilename: 'unit1_RM1_CX_Anim.bin', collisionFilename: 'unit1_RM1_CX_Collision.bin', archiveName: 'unit1_RM1_CX', displacement: [10, 0, 0] },
    { id: 23, name: 'UNIT1_RM1_CX', modelFilename: 'unit1_RM1_CX_Model.bin', animationFilename: 'unit1_RM1_CX_Anim.bin', collisionFilename: 'unit1_RM1_CX_Collision.bin', archiveName: 'unit1_RM1_CX', displacement: [10, 0, 0] },
    { id: 24, name: 'GOREA_C1', modelFilename: 'Gorea_C1_model.bin', animationFilename: 'Gorea_C1_anim.bin', collisionFilename: 'Gorea_C1_collision.bin', archiveName: 'Gorea_C1_CZ', displacement: [0, 0, 20] },
    { id: 25, name: 'UNIT3_MORPH_CZ', modelFilename: 'unit3_morph_CZ_Model.bin', animationFilename: 'unit3_morph_CZ_Anim.bin', collisionFilename: 'unit3_morph_CZ_Collision.bin', archiveName: 'unit3_morph_CZ', displacement: [0, 0, 10] },
    { id: 26, name: 'UNIT3_MORPH_CZ', modelFilename: 'unit3_morph_CZ_Model.bin', animationFilename: 'unit3_morph_CZ_Anim.bin', collisionFilename: 'unit3_morph_CZ_Collision.bin', archiveName: 'unit3_morph_CZ', displacement: [0, 0, 10] },
];

export function findConnectorMetadata(id: number): MPHConnectorMetadata | undefined {
    const connector = connectorMetadata[id];
    assert(connector === undefined || connector.id === id);
    return connector;
}

const multiplayerAreaStart = 0x020BA474;

export function sceneIdToModelStem(sceneId: string): string {
    return sceneId.replace(/_mp$/i, '').toLowerCase();
}

export function findAreaMetadata(areaMetadata: readonly MPHAreaMetadata[], modelStem: string, multiplayer: boolean): MPHAreaMetadata | null {
    const isRequestedMode = (entry: MPHAreaMetadata): boolean =>
        (entry.sourceAddress >= multiplayerAreaStart) === multiplayer;
    const routeEntityFilename = modelStem.replace(/_model$/, '_ent.bin');
    const routeArea = areaMetadata.find((entry) =>
        isRequestedMode(entry) && entry.entityFilename === routeEntityFilename);
    if (routeArea !== undefined)
        return routeArea;
    const candidates = areaMetadata.filter((entry) =>
        isRequestedMode(entry) && entry.modelFilename === `${modelStem}.bin`);
    return candidates.length === 1 ? candidates[0] : null;
}
