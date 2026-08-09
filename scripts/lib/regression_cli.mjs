import { option } from './browser_harness.mjs';

export const expectedWholeGameHashes = new Map([
    ['ge007', '74a9254116f11035'],
]);

export function parseRegressionCLI() {
    const outputPath = option('--output', 'game-regression.jsonl');
    const game = option('--game', null);
    if (game === null)
        throw new Error('--game is required (for example, --game dk64)');
    const screenshotOption = process.argv.indexOf('--screenshot');
    const screenshotsEnabled = screenshotOption >= 0;
    const screenshotArgument = process.argv[screenshotOption + 1];
    const screenshotPath = screenshotsEnabled && screenshotArgument !== undefined && !screenshotArgument.startsWith('--')
        ? screenshotArgument : null;
    const sceneFilter = option('--scene', null);
    const chromePath = option('--chrome', process.env.CHROME ?? 'google-chrome');
    const timeoutMS = Number(option('--timeout', '120000'));
    const runs = Number(option('--runs', '2'));
    if (!Number.isInteger(runs) || runs < 2)
        throw new Error('--runs must be an integer of at least 2');
    return { outputPath, game, screenshotsEnabled, screenshotPath, sceneFilter, chromePath, timeoutMS, runs };
}
