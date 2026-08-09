import ArrayBufferSlice from '../ArrayBufferSlice.js';
import type { MoveEffectMetadata, MoveEffectResourceBank } from './effects.js';

// The extractor rewrites fragment R_MIPS_32 pointers from the game's dynamic
// 0x8FFxxxxx link window into ordinary N64 segment 0x0F addresses.
export const fragmentBase = 0x0F000000;

export interface FragmentMetadata {
    RelocOffset: number;
    SizeInROM: number;
    SizeInRAM: number;
}

export interface PokemonMetadata {
    SpeciesID: number;
    BattleScale: number;
    VariantCount: number;
    /** Runtime material/palette variants independent of geometry layouts. */
    MaterialTextureVariantCount?: number;
    /** Stadium 2's writable generated-geometry/particle root, if present. */
    GeneratedGeometryRoot?: PokemonGeneratedGeometryRoot;
    /** ROM-decoded species 109/110 model-particle frame predicate. */
    ModelParticleAnimationSchedule?: {
        row_size: number;
        frame_rows: number[][];
        callback_ordinal_to_row: number[];
        animation_index_frame_fields: Record<string, number[]>;
    };
    ModelParticleRandomInitialState?: number;
    AnimationCount: number;
    MaterialAnimationCount: number;
    GeoLayouts: number[];
    DisplayLists: number[];
    GeoNodes: PokemonGeoNode[][];
    Animations: PokemonAnimation[];
    MaterialAnimations: PokemonMaterialAnimation[];
    AnimationTableOffset: number | null;
    MaterialAnimationTableOffset: number | null;
    MoveAnimationIDs: number[];
    MoveAnimationFrequencies: number[];
    MoveEffectAttachmentIDs: number[][];
    MoveEffectStartFrames: number[];
    NaturalMoveIDs: number[];
    LegalMoveIDs: number[];
    ReactionAnimationIDs: number[];
    /** Stadium 2 maps serialized logical slots through the model descriptor. */
    AnimationSlotToClip?: number[];
    /** Complete Stadium 2 selection records, including its 20 non-move records. */
    AnimationSelectionRecords?: PokemonAnimationSelectionMetadata[];
}

export interface PokemonGeneratedGeometryRoot {
    offset: number;
    draw_cursor: number;
    frame_generation: number;
    last_frame: number;
    frame_changed: number;
    particle_states_offset: number | null;
    working_buffer_stride: number | null;
    working_buffer_vertex_capacity: number | null;
    embedded_model_segment_offset: number;
    live_vertex_records_offset: number;
    model_segment_template: {
        runtime_address: number;
        rom_offset: number;
        raw_hex: string;
        raw_words: number[];
        segment_type: number;
        vertex_count: number;
        vertex_array_pointer: number;
        display_list_pointer: number;
        vertices: Array<{
            index: number; position: number[]; flag: number; texcoord: number[]; color: number[];
        }>;
        triangles: number[];
        display_list_commands: Array<{ w0: number; w1: number }>;
        auxiliary_assets: Array<{
            field_offset: number; kind: string; runtime_address: number; byte_length: number; raw_hex: string;
            decoded: {
                u16_values: number[];
                s16_values: number[];
                triangles?: number[][];
                matches_display_list?: boolean;
                neighbor_lists?: number[][];
                vertex_values?: number[];
                trailing_values?: number[];
                parallel_lookup_table_addresses?: number[];
                lookup_rows?: Array<{ index: number; values: number[] }>;
            };
        }>;
    } | null;
    working_buffers: Array<{
        index: number; offset: number; initial_s16_0: number; initial_s16_2: number;
        runtime_model_segment_pointer: number;
    } | null>;
    geo_layout_offset: number | null;
}

export interface PokemonAnimationSelectionMetadata {
    LogicalAnimationSlot: number;
    PhysicalAnimationClip: number;
    AnimationParameter: number;
    PrimaryAttachmentID: number;
    SecondaryAttachmentID: number;
    AnimationStartFrameOffset: number;
    AuxiliaryEffectTriggerFrame: number;
    AnimationCompletionFrame: number;
    PrimaryEffectTriggerFrame: number;
    ActiveMoveEffectOffset: number[];
    ActiveMoveEffectScalePercent: number;
    OtherMoveEffectOffset: number[];
    OtherMoveEffectScalePercent: number;
}

export interface PokemonMaterialAnimationChannel {
    FrameCount: number;
    FirstTextureIndex: number;
}

export interface PokemonMaterialAnimation {
    Flags: number;
    StartFrame: number;
    LoopFrame: number;
    ChannelCount: number;
    FrameCount: number;
    TextureIndicesOffset: number;
    Channels: PokemonMaterialAnimationChannel[];
}

export interface PokemonAnimationTrack {
    ScaleCount: number;
    RotationCount: number;
    TranslationCount: number;
    Flags: number;
    ScaleOffset: number;
    RotationOffset: number;
    TranslationOffset: number;
}

export interface PokemonAnimation {
    Flags: number;
    StartFrame: number;
    LoopFrame: number;
    ChannelCount: number;
    FrameCount: number;
    ScaleValuesOffset: number;
    RotationValuesOffset: number;
    TranslationValuesOffset: number;
    Tracks: PokemonAnimationTrack[];
}

export interface PokemonTextureDescriptor {
    Format: number;
    Size: number;
    Width: number;
    Height: number;
    TexelCount: number;
    DataOffset: number;
}

export interface PokemonGeoNode {
    SourceOffset: number;
    Command: number;
    Parent: number;
    Layer: number;
    DisplayList: number;
    Translation: number[];
    Rotation: number[];
    Scale: number[];
    TextureIndex: number;
    PaletteIndex: number;
    MaterialFlags: number;
    MaterialAnimationChannel: number;
    AnimationChannel: number;
    MatrixSlot: number;
    TransformMode: number;
    Color: number;
    Textures: PokemonTextureDescriptor[];
    Palettes: PokemonTextureDescriptor[];
    LightColor: number[];
    LightAngles: number[];
    DrawCallback: number;
    DrawCallbackCommandOffset: number;
    DrawCallbackSemantic?: string;
    DrawCallbackData?: Record<string, unknown>;
    DrawCallbackArgument: number;
    DrawCallbackRawArgument: number;
    /** Command-0x17 source vertex array used by callback-generated segment state. */
    VertexArrayOffset: number;
    VertexCount: number;
    AttachmentID: number;
}

export interface PokemonArchive {
    Data: ArrayBufferSlice;
    Pokemon?: PokemonMetadata;
    Stadium?: StadiumMetadata;
}

/** Complete CRG1 schema emitted by the extractor. */
export interface ExtractedPokemonStadiumArchive extends PokemonArchive {
    Kind: string;
    ID: number;
    SourceROMOffset: number;
    Compression: string;
    Relocations: { Offset: number; Value: number }[];
    Fragment?: FragmentMetadata;
    MoveEffects?: MoveEffectMetadata;
    MoveEffectResourceBanks?: MoveEffectResourceBank[];
}

export interface StadiumMetadata {
    GeoLayouts: number[];
    DisplayLists: number[];
    GeoNodes: PokemonGeoNode[][];
    Background: number;
}

export class FragmentDataMap {
    constructor(private data: ArrayBufferSlice) {}
    public getView(address: number): DataView { return this.data.createDataView(address - fragmentBase); }
    public getRange(address: number): { data: ArrayBufferSlice; start: number } {
        const offset = address - fragmentBase;
        if (offset < 0 || offset >= this.data.byteLength) throw new Error(`address outside Pokémon fragment: 0x${address.toString(16)}`);
        return { data: this.data, start: fragmentBase };
    }
}

export class MoveEffectTextureDataMap {
    public readonly textureCacheNamespace: number;
    constructor(private resource: ArrayBufferSlice, private vertices: ArrayBufferSlice, archiveID: number = -1) {
        this.textureCacheNamespace = archiveID + 1;
    }
    public getView(address: number): DataView {
        const segment = address >>> 24;
        if (segment === 0x02 || segment === 0x0E) return this.resource.createDataView(address & 0x00FFFFFF);
        if (segment === 0x0F) return this.vertices.createDataView(address & 0x00FFFFFF);
        if (((address & 0xFFF00000) >>> 0) === 0x8FF00000) return this.resource.createDataView(address & 0x000FFFFF);
        throw new Error(`address outside move effect buffers: 0x${address.toString(16)}`);
    }
    public getRange(address: number): { data: ArrayBufferSlice; start: number } {
        const segment = address >>> 24;
        if (segment === 0x02) return { data: this.resource, start: 0x02000000 };
        if (segment === 0x0E) return { data: this.resource, start: 0x0E000000 };
        if (segment === 0x0F) return { data: this.vertices, start: 0x0F000000 };
        if (((address & 0xFFF00000) >>> 0) === 0x8FF00000) return { data: this.resource, start: 0x8FF00000 };
        throw new Error(`address outside move effect buffers: 0x${address.toString(16)}`);
    }
}
