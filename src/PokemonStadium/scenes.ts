import { decompress } from 'fzstd';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import * as BYML from '../byml.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { SceneContext } from '../SceneBase.js';
import * as Viewer from '../viewer.js';
import { PokemonArchive } from './archive.js';
import { MoveEffectArchive } from './effects.js';
import { PokemonStadiumRenderer } from './renderer.js';
import { PokemonStadiumBattleTextArchive } from './battle_text.js';

const pathBase = 'PokemonStadium';
class PokemonSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string, private archiveID: string) {}

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const [compressed, compressedEffects, compressedBattleText] = await Promise.all([
            context.dataFetcher.fetchData(`${pathBase}/pokemon/${this.archiveID}.crg1`),
            context.dataFetcher.fetchData(`${pathBase}/move-effects.crg1`),
            context.dataFetcher.fetchData(`${pathBase}/battle-text.crg1`),
        ]);
        const archive = BYML.parse<PokemonArchive>(ArrayBufferSlice.fromView(decompress(compressed.createTypedArray(Uint8Array))), BYML.FileType.CRG1);
        const effects = BYML.parse<MoveEffectArchive>(ArrayBufferSlice.fromView(decompress(compressedEffects.createTypedArray(Uint8Array))), BYML.FileType.CRG1);
        const battleText = BYML.parse<PokemonStadiumBattleTextArchive>(ArrayBufferSlice.fromView(decompress(compressedBattleText.createTypedArray(Uint8Array))), BYML.FileType.CRG1);
        return new PokemonStadiumRenderer(device, archive, effects, battleText);
    }
}

class StadiumSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string, private archiveID: string, private variant: number) {}

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const [compressed, compressedEffects] = await Promise.all([
            context.dataFetcher.fetchData(`${pathBase}/stadium/${this.archiveID}.crg1`),
            context.dataFetcher.fetchData(`${pathBase}/move-effects.crg1`),
        ]);
        const archive = BYML.parse<PokemonArchive>(ArrayBufferSlice.fromView(decompress(compressed.createTypedArray(Uint8Array))), BYML.FileType.CRG1);
        const effects = BYML.parse<MoveEffectArchive>(ArrayBufferSlice.fromView(decompress(compressedEffects.createTypedArray(Uint8Array))), BYML.FileType.CRG1);
        return new PokemonStadiumRenderer(device, archive, effects, undefined, this.variant);
    }
}

const pokemonNames = [
    'Bulbasaur', 'Ivysaur', 'Venusaur', 'Charmander', 'Charmeleon', 'Charizard', 'Squirtle', 'Wartortle', 'Blastoise',
    'Caterpie', 'Metapod', 'Butterfree', 'Weedle', 'Kakuna', 'Beedrill', 'Pidgey', 'Pidgeotto', 'Pidgeot', 'Rattata',
    'Raticate', 'Spearow', 'Fearow', 'Ekans', 'Arbok', 'Pikachu', 'Raichu', 'Sandshrew', 'Sandslash', 'Nidoran♀',
    'Nidorina', 'Nidoqueen', 'Nidoran♂', 'Nidorino', 'Nidoking', 'Clefairy', 'Clefable', 'Vulpix', 'Ninetales',
    'Jigglypuff', 'Wigglytuff', 'Zubat', 'Golbat', 'Oddish', 'Gloom', 'Vileplume', 'Paras', 'Parasect', 'Venonat',
    'Venomoth', 'Diglett', 'Dugtrio', 'Meowth', 'Persian', 'Psyduck', 'Golduck', 'Mankey', 'Primeape', 'Growlithe',
    'Arcanine', 'Poliwag', 'Poliwhirl', 'Poliwrath', 'Abra', 'Kadabra', 'Alakazam', 'Machop', 'Machoke', 'Machamp',
    'Bellsprout', 'Weepinbell', 'Victreebel', 'Tentacool', 'Tentacruel', 'Geodude', 'Graveler', 'Golem', 'Ponyta',
    'Rapidash', 'Slowpoke', 'Slowbro', 'Magnemite', 'Magneton', "Farfetch’d", 'Doduo', 'Dodrio', 'Seel', 'Dewgong',
    'Grimer', 'Muk', 'Shellder', 'Cloyster', 'Gastly', 'Haunter', 'Gengar', 'Onix', 'Drowzee', 'Hypno', 'Krabby',
    'Kingler', 'Voltorb', 'Electrode', 'Exeggcute', 'Exeggutor', 'Cubone', 'Marowak', 'Hitmonlee', 'Hitmonchan',
    'Lickitung', 'Koffing', 'Weezing', 'Rhyhorn', 'Rhydon', 'Chansey', 'Tangela', 'Kangaskhan', 'Horsea', 'Seadra',
    'Goldeen', 'Seaking', 'Staryu', 'Starmie', 'Mr. Mime', 'Scyther', 'Jynx', 'Electabuzz', 'Magmar', 'Pinsir',
    'Tauros', 'Magikarp', 'Gyarados', 'Lapras', 'Ditto', 'Eevee', 'Vaporeon', 'Jolteon', 'Flareon', 'Porygon',
    'Omanyte', 'Omastar', 'Kabuto', 'Kabutops', 'Aerodactyl', 'Snorlax', 'Articuno', 'Zapdos', 'Moltres', 'Dratini',
    'Dragonair', 'Dragonite', 'Mewtwo', 'Mew',
];

const stadiumNames = [
    'Free Battle', 'Poké Cup', 'Poké Cup 2', 'Petit Cup', 'Pika Cup', 'Prime Cup',
    'Gym Leader Castle', 'Pewter Gym', 'Cerulean Gym', 'Vermilion Gym', 'Celadon Gym',
    'Fuchsia Gym', 'Saffron Gym', 'Cinnabar Gym', 'Viridian Gym', 'Elite Four', 'Rival', 'Mewtwo',
] as const;

const stadiumSceneDescs = stadiumNames.map((name, archive) => {
    const archiveID = archive.toString(16).toUpperCase().padStart(2, '0');
    return new StadiumSceneDesc(`stadium-${archiveID}`, name, archiveID, -1);
});
const pokemonSceneDescs = pokemonNames.map((name, index) => new PokemonSceneDesc(
    (index + 1).toString().padStart(3, '0'), name,
    index.toString(16).toUpperCase().padStart(3, '0'),
));
const sceneDescs = ['Stadiums', ...stadiumSceneDescs, 'Pokémon', ...pokemonSceneDescs];

export const sceneGroup: Viewer.SceneGroup = { id: 'pst', name: 'Pokémon Stadium', dataPath: pathBase, sceneDescs };
