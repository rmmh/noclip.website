import type ArrayBufferSlice from '../ArrayBufferSlice.js';

export const archiveVersion = 27;

export interface EnvironmentArchive {
    FogEnabled: boolean;
    Blend: number;
    Far: number;
    FogMin: number;
    FogMax: number;
    Sky: number[];
    CloudEnabled: boolean;
    CloudHeight: number;
    CloudColor: number[];
    SkyImageID: number;
    WaterEnabled: boolean;
    WaterHeight: number;
    WaterColor: number[];
    WaterImageID: number;
    WaterConcavity: number;
}

export interface RoomArchive {
    Index: number;
    Position: number[];
    Center: number[];
    Bounds: number[];
    Vertices: ArrayBufferSlice;
    PrimaryDisplayList: ArrayBufferSlice;
    SecondaryDisplayList: ArrayBufferSlice;
}

export interface PortalArchive {
    Address: number;
    Room1: number;
    Room2: number;
    Flags: number;
    Points: number[][];
}

export interface ModelBSPPathArchive {
    Index: number;
    Side: number;
}

export interface ModelBSPPlaneArchive {
    Point: number[];
    Vector: number[];
    Mode: number;
    Matrix: number[];
}

export interface ModelDisplayListArchive {
    Offset: number;
    VertexBase: number;
    Matrix: number[];
    ModelType?: number;
    Secondary?: boolean;
    LODMin?: number;
    LODMax?: number;
    ScreenIndex?: number;
    BSPPath?: ModelBSPPathArchive[];
}

export interface ModelShadowArchive {
    Position: number[];
    Size: number[];
    TextureID: number;
    Matrix: number[];
}

export interface ModelScreenArchive {
    Index: number;
    VertexBase: number;
    Matrix: number[];
}

export interface ModelArchive {
    ID: number;
    Name: string;
    Scale: number;
    Data: ArrayBufferSlice;
    DisplayLists: ModelDisplayListArchive[];
    Matrices: (number[] | null)[];
    AttachmentMatrix?: number[];
    Bounds?: number[];
    AttachmentMatrices?: (number[] | null)[];
    Shadows: ModelShadowArchive[];
    NodeTypes: number[];
    Screens: ModelScreenArchive[];
    BSPPlanes: ModelBSPPlaneArchive[];
    DoorClip?: { VertexBase: number; VertexCount: number };
}

export interface PropArchive {
    Type: number;
    ModelID: number;
    Scale: number;
    Position: number[];
    Up: number[];
    Look: number[];
    SetupIndex?: number;
    OwnerSetupIndex?: number;
    OwnerPart?: number;
    HeadModelID?: number;
    BoundSize?: number[];
    DoorType?: number;
    DoorFlags?: number;
    LinkedDoorOffset?: number;
    MaxOpenFraction?: number;
    DoorTravel?: number[];
    DoorPivot?: number[];
    DoorScale?: number;
    ChrNum?: number;
    AttachmentIndex?: number;
    Flags?: number;
    Flags2?: number;
    MonitorTextureIDs?: number[];
    MonitorAnimationIDs?: number[];
    TintDistance?: number;
    OpaqueDistance?: number;
    MinimumOpacity?: number;
    ShadeColor?: number[];
    RoomIndex?: number;
    FloorY?: number;
    InitiallyHidden?: boolean;
}

export interface TextureArchive {
    ID: number;
    Width: number;
    Height: number;
    Pixels: ArrayBufferSlice;
    LOD1Width?: number;
    LOD1Height?: number;
    LOD1Pixels?: ArrayBufferSlice;
}

export interface LevelArchive {
    Version: number;
    ID: string;
    Name: string;
    Code: string;
    Scale: number;
    VisibilityScale: number;
    Environment: EnvironmentArchive;
    Stan: ArrayBufferSlice;
    Setup: ArrayBufferSlice;
    GlobalImageTable: ArrayBufferSlice;
    Textures: TextureArchive[];
    Rooms: RoomArchive[];
    Portals: PortalArchive[];
    GlobalVisibility: ArrayBufferSlice;
    Models: ModelArchive[];
    Props: PropArchive[];
    Characters: ModelArchive[];
    Heads: ModelArchive[];
    Guards: PropArchive[];
    MonitorAnimationData: ArrayBufferSlice;
    MonitorAnimationRoots: number[];
    InitialCamera?: { Position: number[]; Look: number[]; Up: number[]; RoomIndex?: number };
}
