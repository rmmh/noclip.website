import ArrayBufferSlice from '../ArrayBufferSlice.js';

export interface PokemonStadiumBattleFont {
    GlyphWidth: number;
    GlyphHeight: number;
    Widths: number[];
    CharacterMap: number[];
    Glyphs: ArrayBufferSlice;
}

export interface PokemonStadiumBattleTextArchive {
    Kind: 'battle-text';
    PokemonNames: string[];
    MoveNames: string[];
    BattleMessages: string[];
    MoveResultMessageIDs: number[];
    UsedMoveTemplate: string;
    Font: PokemonStadiumBattleFont;
    BorderTiles: ArrayBufferSlice[];
}
