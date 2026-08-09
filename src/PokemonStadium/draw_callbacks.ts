export const pokemonDrawCallback = {
    I4Texture32A: 0x81000028,
    WhitePrimitive: 0x81000030,
    I4Texture32B: 0x81000038,
    DualI4Texture64A: 0x81000040,
    DualI4Texture64B: 0x81000048,
    I4Texture32C: 0x81000050,
    WhitePrimitiveBlackEnvironmentA: 0x81000058,
    PinkEnvironment: 0x81000060,
    YellowEnvironment: 0x81000068,
    CyanDualI4TextureA: 0x81000070,
    I4Texture32D: 0x81000078,
    I4Texture32E: 0x81000080,
    CyanDualI4TextureB: 0x81000088,
    CyanDualI4Primitive: 0x81000090,
    WhitePrimitiveBlackEnvironmentB: 0x810000A0,
    ExternalDisplayList: 0x810000B8,
    DualI4Texture32A: 0x810000C0,
    GeneratedTextureCoordinates: 0x810000C8,
    LinearGeneratedTextureCoordinates: 0x810000D0,
    AnimatedIA8Ribbon: 0x810000D8,
    EmptyModelParticlePool: 0x810000E0,
    RGBA16Texture32: 0x810000E8,
    WhitePrimitiveBlackEnvironmentC: 0x810000F0,
    TwoDisplayLists: 0x810000F8,
    DualTextureScroll: 0x81000100,
    ScrollingRGBA16: 0x81000108,
    IndexedTexture: 0x81000110,
    PuddleTexture: 0x81000118,
    RepeatedDualI4Texture: 0x81000120,
    WhitePrimitiveBlackEnvironmentD: 0x81000128,
    DualI4Texture32B: 0x81000130,
    DualI4Texture32C: 0x81000138,
    LeerEyeTexture: 0x81000140,
    RedPrimitiveAlpha: 0x81000148,
    DualI4Texture32D: 0x81000150,
    WhitePrimitiveBlackEnvironmentE: 0x81000158,
    DualI4Texture32WithLOD: 0x81000160,
    AnimationVisibility: 0x810001E8,
    InvertedAnimationVisibility: 0x810001F0,
} as const;

/** Draw callbacks currently reproduced by PokemonStadiumRenderer. */
export const implementedPokemonDrawCallbacks = new Set<number>(Object.values(pokemonDrawCallback));

/** Complete callback inventory in the extracted Pokémon and move-effect model archives. */
export const knownPokemonDrawCallbacks = new Set(implementedPokemonDrawCallbacks);

export const moveEffectScreenFlashUpdates = new Set([
    0x32CD0, 0x32DB0, 0x32E6C, 0x32F30, 0x32FD0, 0x330A0,
]);

export const cyclingModelTintUpdate = 0x32964;
export const modelOpacityFadeUpdate = 0x32AFC;
export const modelTintUpdateRange = { First: 0x31EAC, Last: modelOpacityFadeUpdate } as const;

/** Referenced dispatches which intentionally produce no standalone visual. */
export const intentionallyNonVisualMoveEffectPrimitives = new Set(['attacker:29']);

const emptyMoveEffectDispatches: readonly (readonly [number, number, number])[] = [
    [0x593A0, 0x593B0, 0x593C0],
    [0x593A8, 0x593B8, 0x593C8],
];

export function isEmptyMoveEffectDispatch(spawn: number, update: number, render: number): boolean {
    return emptyMoveEffectDispatches.some((dispatch) =>
        dispatch[0] === spawn && dispatch[1] === update && dispatch[2] === render);
}
