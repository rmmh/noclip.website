import { readFileSync } from 'fs';
import { join } from 'path';
import { decompress } from 'fzstd';
import ArrayBufferSlice from '../../ArrayBufferSlice.js';
import * as BYML from '../../byml.js';
import type { PokemonArchive } from '../archive.js';
import {
    defaultParticleModelResourceIDs, getCustomMoveEffectLifecycle, MoveEffectArchive, MoveEffectParticleSpawn,
    MoveEffectPrimitive, MoveEffectResolver,
} from '../effects.js';
import { StadiumMoveEffectCallbackVM, StadiumMoveEffectParticleState } from '../MoveEffectVM.js';
import {
    cyclingModelTintUpdate, implementedPokemonDrawCallbacks, intentionallyNonVisualMoveEffectPrimitives,
    isEmptyMoveEffectDispatch, knownPokemonDrawCallbacks, modelTintUpdateRange, moveEffectScreenFlashUpdates,
} from '../draw_callbacks.js';
import type { PokemonStadiumBattleTextArchive } from '../battle_text.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function readArchive<T>(path: string): T {
    const decompressed = decompress(readFileSync(path));
    return BYML.parse(ArrayBufferSlice.fromView(decompressed), BYML.FileType.CRG1) as T;
}

const dataRoot = process.argv[2] ?? './data/PokemonStadium';
const battleText = readArchive<PokemonStadiumBattleTextArchive>(join(dataRoot, 'battle-text.crg1'));
assert(battleText.Kind === 'battle-text' && battleText.PokemonNames.length === 151 && battleText.MoveNames.length === 165,
    'invalid Pokémon Stadium battle-text archive');
assert(battleText.UsedMoveTemplate === '#25 used #29!' && battleText.PokemonNames[3] === 'CHARMANDER' && battleText.MoveNames[91] === 'TOXIC',
    'Pokémon Stadium battle-text archive has unexpected labels');
assert(battleText.BattleMessages[0x45] === 'ATTACK greatly increased!' && battleText.MoveResultMessageIDs[14] === 0x45,
    'Pokémon Stadium battle-text archive has unexpected result messages');
assert(battleText.Font.GlyphWidth === 16 && battleText.Font.GlyphHeight === 10 && battleText.Font.Widths.length === 144 &&
    battleText.Font.CharacterMap.length === 192 && battleText.Font.Glyphs.byteLength === 144 * 16 * 10 &&
    battleText.BorderTiles.length === 8 && battleText.BorderTiles.every((tile) => tile.byteLength === 8 * 8 * 2),
'Pokémon Stadium battle-text archive has invalid font or frame assets');
let skeletalClipCount = 0;
let materialClipCount = 0;
let pairedClipCount = 0;
const pokemonDrawCallbackCounts = new Map<number, number>();
const moveEffectDrawCallbackCounts = new Map<number, number>();

for (let species = 0; species < 151; species++) {
    const id = species.toString(16).toUpperCase().padStart(3, '0');
    const archive = readArchive<PokemonArchive>(join(dataRoot, 'pokemon', `${id}.crg1`));
    const pokemon = archive.Pokemon;
    assert(pokemon !== undefined, `${id}: missing Pokémon metadata`);
    assert(pokemon.SpeciesID === species + 1, `${id}: species ID ${pokemon.SpeciesID}`);
    assert(Number.isFinite(pokemon.BattleScale) && pokemon.BattleScale > 0, `${id}: invalid battle scale ${pokemon.BattleScale}`);
    assert(pokemon.GeoNodes.length === pokemon.VariantCount && pokemon.GeoNodes.length > 0, `${id}: invalid model variants`);
    assert(pokemon.Animations.length === pokemon.AnimationCount && pokemon.Animations.length > 0, `${id}: invalid skeletal animation table`);
    assert(pokemon.MaterialAnimations.length === pokemon.MaterialAnimationCount, `${id}: invalid material animation table`);
    assert(Array.isArray(pokemon.LegalMoveIDs) && pokemon.LegalMoveIDs.length > 0, `${id}: missing legal move pool`);
    assert(Array.isArray(pokemon.NaturalMoveIDs) && pokemon.NaturalMoveIDs.length > 0 &&
        pokemon.NaturalMoveIDs.every((moveID: number, index: number, moves: number[]) =>
            Number.isInteger(moveID) && moveID > 0 && moveID <= 165 && moves.indexOf(moveID) === index),
    `${id}: natural move pool is missing or invalid`);
    assert(Array.isArray(pokemon.MoveEffectAttachmentIDs) && pokemon.MoveEffectAttachmentIDs.length === 165,
        `${id}: missing per-move effect attachments`);
    assert(pokemon.MoveEffectAttachmentIDs.every((attachments: number[]) => attachments.length <= 2 &&
        attachments.every((attachmentID) => Number.isInteger(attachmentID) && attachmentID >= 0 && attachmentID < 0xFF)),
    `${id}: invalid per-move effect attachment`);
    assert(Array.isArray(pokemon.MoveEffectStartFrames) && pokemon.MoveEffectStartFrames.length === 165 &&
        pokemon.MoveEffectStartFrames.every((frame: number) => Number.isInteger(frame) && frame >= 0 && frame <= 0xFF),
    `${id}: invalid per-move effect start frames`);
    assert(pokemon.LegalMoveIDs.every((moveID: number, index: number, moves: number[]) =>
        Number.isInteger(moveID) && moveID > 0 && moveID <= 165 && (index === 0 || moves[index - 1] < moveID)),
    `${id}: legal move pool is invalid or unsorted`);
    assert(pokemon.NaturalMoveIDs.every((moveID: number) => pokemon.LegalMoveIDs.includes(moveID)),
        `${id}: natural move missing from legal move pool`);
    const dataView = archive.Data.createDataView();
    for (const node of pokemon.GeoNodes.flat()) {
        if (node.DrawCallback !== 0)
            pokemonDrawCallbackCounts.set(node.DrawCallback, (pokemonDrawCallbackCounts.get(node.DrawCallback) ?? 0) + 1);
    }
    const maxTextureCount = Math.max(0, ...pokemon.GeoNodes.flat().map((node) => node.Textures.length));

    for (const [index, animation] of pokemon.Animations.entries()) {
        assert(animation.FrameCount > animation.StartFrame, `${id}: skeletal clip ${index} has no frames`);
        assert(animation.Tracks.length === animation.ChannelCount, `${id}: skeletal clip ${index} channel mismatch`);
        assert(animation.ScaleValuesOffset >= 0 && animation.ScaleValuesOffset < dataView.byteLength, `${id}: skeletal scale data outside archive`);
        assert(animation.RotationValuesOffset >= 0 && animation.RotationValuesOffset < dataView.byteLength, `${id}: skeletal rotation data outside archive`);
        assert(animation.TranslationValuesOffset >= 0 && animation.TranslationValuesOffset < dataView.byteLength, `${id}: skeletal translation data outside archive`);
    }

    const unusedMaterial = new Set(pokemon.MaterialAnimations);
    for (const animation of pokemon.Animations) {
        const paired = pokemon.MaterialAnimations.find((candidate) => unusedMaterial.has(candidate) && candidate.FrameCount === animation.FrameCount);
        if (paired !== undefined) { unusedMaterial.delete(paired); pairedClipCount++; }
    }
    for (const [index, animation] of pokemon.MaterialAnimations.entries()) {
        assert(animation.FrameCount > animation.StartFrame, `${id}: material clip ${index} has no frames`);
        assert(animation.Channels.length === animation.ChannelCount, `${id}: material clip ${index} channel mismatch`);
        for (const channel of animation.Channels) {
            assert(channel.FrameCount > 0, `${id}: material clip ${index} has an empty channel`);
            const end = animation.TextureIndicesOffset + channel.FirstTextureIndex + channel.FrameCount;
            assert(end <= dataView.byteLength, `${id}: material clip ${index} indices outside archive`);
            for (let frame = 0; frame < channel.FrameCount; frame++) {
                const textureIndex = dataView.getUint8(animation.TextureIndicesOffset + channel.FirstTextureIndex + frame);
                assert(textureIndex < maxTextureCount, `${id}: material clip ${index} selects texture ${textureIndex}/${maxTextureCount}`);
            }
        }
    }
    skeletalClipCount += pokemon.Animations.length;
    materialClipCount += pokemon.MaterialAnimations.length;
}

let stadiumLayoutCount = 0;
for (let stadium = 0; stadium < 18; stadium++) {
    const id = stadium.toString(16).toUpperCase().padStart(2, '0');
    const archive = readArchive<PokemonArchive>(join(dataRoot, 'stadium', `${id}.crg1`));
    const metadata = archive.Stadium;
    assert(metadata !== undefined, `${id}: missing stadium metadata`);
    assert(metadata.GeoLayouts.length === 3 && metadata.GeoNodes.length === 3, `${id}: expected three fragment entry layouts`);
    assert(Number.isInteger(metadata.Background), `${id}: missing battle background return`);
    assert(metadata.GeoNodes.every((layout) => layout.length > 0), `${id}: empty stadium layout`);
    assert(metadata.GeoNodes.flat().some((node) => node.DisplayList >= 0), `${id}: stadium emits no display lists`);
    stadiumLayoutCount += metadata.GeoLayouts.length;
}

const moveEffectArchive = readArchive<MoveEffectArchive>(join(dataRoot, 'move-effects.crg1'));
const moveEffects = moveEffectArchive.MoveEffects;
assert(moveEffects !== undefined, 'missing move effect metadata');
assert(moveEffects.MoveCount === 166 && moveEffects.Scripts.length === 166, 'expected all 166 Generation I move scripts');
assert(moveEffects.AttackerPrimitiveCount === 145, 'attacker effect primitive table size mismatch');
assert(moveEffects.TargetPrimitiveCount === 90, 'target effect primitive table size mismatch');
assert(moveEffects.AttackerPrimitives.length === moveEffects.AttackerPrimitiveCount, 'attacker primitive metadata size mismatch');
assert(moveEffects.TargetPrimitives.length === moveEffects.TargetPrimitiveCount, 'target primitive metadata size mismatch');
assert(moveEffects.RenderDescriptors.length >= 57, 'move effect render descriptor table is truncated');
for (const [index, descriptor] of moveEffects.RenderDescriptors.entries()) {
    assert(typeof descriptor.GeometryKind === 'string', `move effect descriptor ${index}: missing authored geometry kind`);
    assert(typeof descriptor.Billboard === 'boolean', `move effect descriptor ${index}: missing billboard mode`);
    assert(Number.isInteger(descriptor.GeometryResourceID) && descriptor.GeometryResourceID >= -1,
        `move effect descriptor ${index}: invalid geometry resource`);
    assert(descriptor.DualTextureMode === 'none' || descriptor.DualTextureMode === 'colorAndAlpha' || descriptor.DualTextureMode === 'colorOnly',
        `move effect descriptor ${index}: invalid dual-texture mode`);
    if (descriptor.DualTextureMode === 'none') {
        assert(descriptor.SecondaryResourceID === -1, `move effect descriptor ${index}: unused secondary texture`);
    } else {
        assert(descriptor.SecondaryResourceID >= 0, `move effect descriptor ${index}: missing secondary texture`);
        assert(descriptor.SecondaryWidth > 0 && descriptor.SecondaryHeight > 0,
            `move effect descriptor ${index}: invalid secondary texture dimensions`);
    }
}
assert(moveEffects.ParticleStyles.length === 85, 'move effect particle style table size mismatch');
for (const [index, style] of moveEffects.ParticleStyles.entries()) {
    assert(style.Type === 1 || style.Type === 3, `particle style ${index}: unknown type ${style.Type}`);
    if (style.Type === 1 || style.RenderDescriptor >= 0)
        assert(style.RenderDescriptor >= 0 && style.RenderDescriptor < moveEffects.RenderDescriptors.length,
            `particle style ${index}: render descriptor outside table`);
}
for (const [kind, primitives] of [['attacker', moveEffects.AttackerPrimitives], ['target', moveEffects.TargetPrimitives]] as const) {
    for (const [primitiveIndex, primitive] of primitives.entries()) {
        const expectedCustomLifecycle = getCustomMoveEffectLifecycle(primitive.SpawnFunction);
        assert(primitive.CustomLifecycle === expectedCustomLifecycle,
            `${kind} primitive ${primitiveIndex}: custom lifecycle classification mismatch`);
        for (const [spawnIndex, spawn] of primitive.ParticleSpawns.entries()) {
            assert(spawn.InitialState !== undefined, `${kind} primitive ${primitiveIndex} spawn ${spawnIndex}: missing initial particle state`);
            const expected = [spawn.InitialState.A6, spawn.InitialState.AA, spawn.InitialState.CC,
                spawn.InitialState.CD, spawn.InitialState.CF, spawn.InitialState.CE];
            assert(expected.every((value, field) => value === (spawn.Arguments[field] ?? -1)),
                `${kind} primitive ${primitiveIndex} spawn ${spawnIndex}: initial particle state does not match scheduler arguments`);
        }
    }
}
assert(moveEffectArchive.MoveEffectResourceBanks?.length === 63, 'expected all 63 move effect resource banks');
assert(moveEffects.Resources.length > 0, 'empty move effect resource table');
const moveEffectResourceBanks = new Map(moveEffectArchive.MoveEffectResourceBanks.map((bank) => [bank.ArchiveID, bank]));
const moveEffectResourceIDs = new Set<string>();
for (const resource of moveEffects.Resources) {
    const key = `${resource.ArchiveID}:${resource.ResourceID}`;
    assert(!moveEffectResourceIDs.has(key), `duplicate move effect resource ${key}`);
    moveEffectResourceIDs.add(key);
    const bank = moveEffectResourceBanks.get(resource.ArchiveID);
    assert(bank !== undefined && resource.DataOffset >= 0 && resource.DataOffset < bank.Data.byteLength,
        `move effect resource ${key} outside resource bank`);
    if (resource.Type === 3) {
        assert(resource.GeoNodes?.length > 0, `move effect geo resource ${key} has no parsed nodes`);
        for (const node of resource.GeoNodes) {
            if (node.DrawCallback !== 0)
                moveEffectDrawCallbackCounts.set(node.DrawCallback, (moveEffectDrawCallbackCounts.get(node.DrawCallback) ?? 0) + 1);
        }
    }
}
const observedModelDrawCallbacks = new Set([...pokemonDrawCallbackCounts.keys(), ...moveEffectDrawCallbackCounts.keys()]);
assert([...observedModelDrawCallbacks].every((callback) => knownPokemonDrawCallbacks.has(callback)) &&
    [...knownPokemonDrawCallbacks].every((callback) => observedModelDrawCallbacks.has(callback)),
`Pokémon Stadium model draw callback inventory changed: ${[...observedModelDrawCallbacks].sort((a, b) => a - b).map((callback) => `0x${callback.toString(16)}`).join(', ')}`);
const missingModelDrawCallbacks = [...observedModelDrawCallbacks]
    .filter((callback) => !implementedPokemonDrawCallbacks.has(callback))
    .sort((a, b) => a - b);
for (const callback of missingModelDrawCallbacks) {
    const pokemonCount = pokemonDrawCallbackCounts.get(callback) ?? 0;
    const effectCount = moveEffectDrawCallbackCounts.get(callback) ?? 0;
    console.warn(`Pokémon Stadium draw callback 0x${callback.toString(16)} is not implemented ` +
        `(${pokemonCount} Pokémon nodes, ${effectCount} move-effect nodes)`);
}
for (const [side, primitives] of [['attacker', moveEffects.AttackerPrimitives], ['target', moveEffects.TargetPrimitives]] as const) {
    for (const [index, primitive] of primitives.entries()) {
        for (const [stage, address] of Object.entries(primitive).filter(([stage]) => stage.endsWith('Function')))
            assert(address >= 0x2E000 && address < 0x5D000, `${side} primitive ${index}: ${stage} function 0x${address.toString(16)} outside fragment code`);
        for (const style of primitive.ParticleStyles)
            assert(style >= 0 && style < moveEffects.ParticleStyles.length, `${side} primitive ${index}: particle style ${style} outside table`);
        for (const spawn of primitive.ParticleSpawns) {
            assert(spawn.ParticleStyle >= 0 && spawn.ParticleStyle < moveEffects.ParticleStyles.length || spawn.ParticleStyle === -1,
            `${side} primitive ${index}: spawn style ${spawn.ParticleStyle} outside table`);
            assert(spawn.Delay >= -1 && spawn.Interval >= -1 && spawn.BurstCount >= -1,
                `${side} primitive ${index}: invalid spawn timing`);
            for (const palette of spawn.PaletteIndices)
                assert(palette >= 0 && palette < 81, `${side} primitive ${index}: particle palette ${palette} outside gMoveEffectColorPairs`);
            for (const color of [...spawn.PrimitiveColorIndices, ...spawn.EnvironmentColorIndices])
                assert(color >= 0 && color < 66, `${side} primitive ${index}: particle color ${color} outside gMoveEffectColors`);
            for (const call of spawn.BehaviorCalls)
                assert(((call.Function & 0xFFF00000) >>> 0) === 0x81400000 && call.Arguments.length === 6,
                    `${side} primitive ${index}: invalid fragment34 behavior call`);
        }
        for (const tint of primitive.ModelTints) {
            assert(tint.Delay >= 0, `${side} primitive ${index}: model tint has unresolved delay`);
            assert(tint.UpdateFunction >= modelTintUpdateRange.First && tint.UpdateFunction <= modelTintUpdateRange.Last,
                `${side} primitive ${index}: model tint callback outside known family`);
            assert(tint.Arguments.length === 6,
                `${side} primitive ${index}: model tint argument count mismatch`);
        }
    }
}
let movePrimitiveReferenceCount = 0;
const referencedMovePrimitives = new Map<string, MoveEffectPrimitive>();
for (const [move, script] of moveEffects.Scripts.entries()) {
    for (const primitive of [...script.AttackerSetup, ...script.AttackerAction]) {
        assert(primitive > 0 && primitive < moveEffects.AttackerPrimitiveCount,
            `move ${move}: attacker primitive ${primitive} outside dispatch table`);
        referencedMovePrimitives.set(`attacker:${primitive}`, moveEffects.AttackerPrimitives[primitive]);
        movePrimitiveReferenceCount++;
    }
    for (const primitive of script.TargetAction) {
        assert(primitive > 0 && primitive < moveEffects.TargetPrimitiveCount,
            `move ${move}: target primitive ${primitive} outside dispatch table`);
        referencedMovePrimitives.set(`target:${primitive}`, moveEffects.TargetPrimitives[primitive]);
        movePrimitiveReferenceCount++;
    }
    for (const attachment of [...script.AttackerAttachments, ...script.TargetAttachments])
        assert(attachment < 0x3F, `move ${move}: invalid attachment channel ${attachment}`);
}

// A referenced primitive must reach one of the viewer's three output paths:
// an ordinary fragment34 particle descriptor, a full-screen style-37 update,
// a model-light callback, or a dedicated Stadium lifecycle. This is stricter
// than merely checking that extraction found a setup function: it prevents a
// successfully parsed but visually empty move from passing validation.
let intentionallyEmptyPrimitiveCount = 0;
for (const [key, primitive] of referencedMovePrimitives) {
    const particleOutput = primitive.ParticleSpawns.some((spawn) => {
        if (spawn.ParticleStyle < 0)
            return spawn.ModelResources.length > 0 || defaultParticleModelResourceIDs(spawn.InitialState.CF) !== null;
        const style = moveEffects.ParticleStyles[spawn.ParticleStyle];
        return style.RenderDescriptor >= 0 ||
            (spawn.ParticleStyle === 37 && moveEffectScreenFlashUpdates.has(spawn.UpdateFunction));
    });
    const emptyDispatch = isEmptyMoveEffectDispatch(primitive.SpawnFunction, primitive.UpdateFunction, primitive.RenderFunction);
    const intentionallyEmpty = (primitive.ParticleSpawns.length === 0 && primitive.ModelTints.length === 0 &&
        primitive.CustomLifecycle === null && emptyDispatch) || intentionallyNonVisualMoveEffectPrimitives.has(key);
    if (intentionallyEmpty) intentionallyEmptyPrimitiveCount++;
    assert(particleOutput || primitive.ModelTints.length > 0 || primitive.CustomLifecycle !== null || intentionallyEmpty,
        `${key}: referenced move primitive has no implemented visual output`);
}

const moveEffectResolver = new MoveEffectResolver(moveEffectArchive);
let maximumMoveResourceCount = 0;
for (let move = 0; move < moveEffects.MoveCount; move++) {
    const resolved = moveEffectResolver.resolve(move);
    maximumMoveResourceCount = Math.max(maximumMoveResourceCount, resolved.Resources.size);
    assert(resolved.AttackerSetup.length === moveEffects.Scripts[move].AttackerSetup.length, `move ${move}: setup resolution mismatch`);
    assert(resolved.AttackerAction.length === moveEffects.Scripts[move].AttackerAction.length, `move ${move}: attacker resolution mismatch`);
    assert(resolved.TargetAction.length === moveEffects.Scripts[move].TargetAction.length, `move ${move}: target resolution mismatch`);
}

const callbackVM = new StadiumMoveEffectCallbackVM(moveEffectArchive.Data);
let callbackSpawnCount = 0, terminatingCallbackSpawnCount = 0;
const unimplementedMoveEffectFunctions = new Set<number>();
const callbackLifecycleAuditFrames = 600;
const externallyOwnedCallbacks = new Map<number, number>();
const externallyOwnedStates: string[] = [];
let modelTintCallbackCount = 0, terminatingModelTintCallbackCount = 0;
const distinctModelTintCallbacks = new Set<number>();
for (const primitives of [moveEffects.AttackerPrimitives, moveEffects.TargetPrimitives]) {
    for (const primitive of primitives) {
        for (const spawn of primitive.ParticleSpawns) {
            if (spawn.UpdateFunction < 0) continue;
            callbackSpawnCount++;
            const particle = new StadiumMoveEffectParticleState(spawn, 0);
            const firstFrameCalls = callbackVM.runFrame(spawn.UpdateFunction, particle);
            assert(firstFrameCalls.length > 0, `callback 0x${spawn.UpdateFunction.toString(16)} executed no fragment34 calls`);
            assert(particle.getS16(0xB2) !== 1,
                `callback 0x${spawn.UpdateFunction.toString(16)} did not leave its initialization phase`);
            for (let frame = 1; frame < callbackLifecycleAuditFrames && particle.alive; frame++) callbackVM.runFrame(spawn.UpdateFunction, particle);
            for (const address of particle.unimplementedFunctions) unimplementedMoveEffectFunctions.add(address);
            if (!particle.alive) terminatingCallbackSpawnCount++;
            else {
                externallyOwnedCallbacks.set(spawn.UpdateFunction, (externallyOwnedCallbacks.get(spawn.UpdateFunction) ?? 0) + 1);
                externallyOwnedStates.push(`0x${spawn.UpdateFunction.toString(16)} phase ${particle.getS16(0xB2)} y ${particle.getF32(0x30).toFixed(2)} position ${particle.snapshot().Position.map((v) => v.toFixed(2)).join('/')}`);
            }
        }
    }
}

for (const primitives of [moveEffects.AttackerPrimitives, moveEffects.TargetPrimitives]) {
    for (const primitive of primitives) {
        for (const tint of primitive.ModelTints) {
            const [a6, aa, cc, cd, cf, ce] = tint.Arguments;
            const spawn: MoveEffectParticleSpawn = {
                Delay: tint.Delay, Interval: 0, Mode: 1, BurstCount: 1, UpdateFunction: tint.UpdateFunction, ParticleStyle: -1,
                ModelAnimationFrameCount: 0,
                ModelResources: [],
                Arguments: [...tint.Arguments], InitialState: { A6: a6, AA: aa, CC: cc, CD: cd, CF: cf, CE: ce },
                PaletteIndices: [], PrimitiveColorIndices: [], EnvironmentColorIndices: [], BehaviorCalls: [],
            };
            const particle = new StadiumMoveEffectParticleState(spawn, 0);
            const firstFrameCalls = callbackVM.runFrame(tint.UpdateFunction, particle);
            let sawCyclingTintColor = tint.UpdateFunction !== cyclingModelTintUpdate ||
                particle.getU8(0xBE) !== 0 || particle.getU8(0xBF) !== 0 || particle.getU8(0xC0) !== 0;
            assert(firstFrameCalls.length > 0, `model-light callback 0x${tint.UpdateFunction.toString(16)} executed no fragment34 calls`);
            assert(particle.getS16(0xB2) !== 1,
                `model-light callback 0x${tint.UpdateFunction.toString(16)} did not leave its initialization phase`);
            for (let frame = 1; frame < callbackLifecycleAuditFrames && particle.alive; frame++) {
                callbackVM.runFrame(tint.UpdateFunction, particle);
                sawCyclingTintColor ||= particle.getU8(0xBE) !== 0 || particle.getU8(0xBF) !== 0 || particle.getU8(0xC0) !== 0;
            }
            assert(sawCyclingTintColor, 'cycling model tint never loaded fragment34 palette colors');
            for (const address of particle.unimplementedFunctions) unimplementedMoveEffectFunctions.add(address);
            if (!particle.alive) terminatingModelTintCallbackCount++;
            distinctModelTintCallbacks.add(tint.UpdateFunction);
            modelTintCallbackCount++;
        }
    }
}

assert(unimplementedMoveEffectFunctions.size === 0,
    `unimplemented move-effect helpers: ${[...unimplementedMoveEffectFunctions].sort((a, b) => a - b).map((address) => `0x${address.toString(16)}`).join(', ')}`);
assert(callbackVM.unimplementedInstructions.size === 0,
    `unimplemented move-effect instructions: ${[...callbackVM.unimplementedInstructions].map((instruction) => `0x${instruction.toString(16)}`).join(', ')}`);
console.log(`Externally owned callbacks: ${[...externallyOwnedCallbacks].sort((a, b) => a[0] - b[0]).map(([address, count]) => `0x${address.toString(16)} (${count})`).join(', ')}`);
console.log(`Externally owned states: ${externallyOwnedStates.join(', ')}`);
console.log(`Validated 151 Pokémon (${skeletalClipCount} skeletal clips, ${materialClipCount} material clips, ${pairedClipCount} paired), 18 stadium archives (${stadiumLayoutCount} layouts), and 166 move effects (${movePrimitiveReferenceCount} primitive references, ${referencedMovePrimitives.size - intentionallyEmptyPrimitiveCount} visually active and ${intentionallyEmptyPrimitiveCount} intentional no-op primitive definitions, ${moveEffects.Resources.length} resources, ${callbackSpawnCount} particle and ${modelTintCallbackCount} model-light callbacks (${distinctModelTintCallbacks.size} distinct) / ${terminatingCallbackSpawnCount} particle and ${terminatingModelTintCallbackCount} model-light callbacks self-terminal within ${callbackLifecycleAuditFrames} frames, up to ${maximumMoveResourceCount} active)`);
