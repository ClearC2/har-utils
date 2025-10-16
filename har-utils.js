#!/usr/bin/env node
/**
 * @file har-utils.js
 * @summary Interactive menu/launcher for the HAR toolchain.
 * @description Presents C/G/R/Q options, spawns the respective script as a child process,
 * inherits stdio, and returns to the menu after each run until Quit is chosen.
 */

const { spawn } = require('child_process');
/** Readline helpers for menu input and prompts with defaults. */
const { rlCreate, askWithDefault } = require('./build-har-common');

/**
 * Run a Node.js script once as a child process and return its exit code.
 * @param {string} script  Path to the script to execute with the current Node binary.
 * @returns {Promise<number>} Child exit code (0 on normal completion).
 */
async function runOnce(script) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script], { stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 0));
        child.on('error', (err) => {
            console.error('Failed to launch', script, err);
            resolve(1);
        });
    });
}

/** Main loop: render menu, read choice, launch tool, repeat until Quit. */
(async () => {
    while (true) {
        const rl = rlCreate();
        console.log("\n");
        console.log("\n");
        console.log('\n=== HAR Utilities Suite ===\n');
        console.log('Available tools:');
        console.log('  (C) Config Builder  — scan SQL + HAR to define API↔SQL mappings.');
        console.log('  (G) HAR Generator   — generate synthetic HAR traffic from config.');
        console.log('  (R) HAR Runner      — execute HARs, measure API performance.');
        console.log('  (Q) Quit.\n');

        const mode = (await askWithDefault(rl, 'Enter mode (C/G/R/Q)', 'R')).trim().toUpperCase();
        rl.close();

        if (mode === 'Q') {
            console.log('Goodbye.');
            process.exit(0);
        }

        let script;
        switch (mode) {
            case 'C':
                script = 'build-har-config.js';
                break;
            case 'G':
                script = 'build-har-generator.js';
                break;
            case 'R':
                script = 'har-runner.js';
                break;
            default:
                console.log('Unknown choice. Please enter C, G, R, or Q.');
                continue;
        }

        const label =
            mode === 'C' ? 'Config Builder (C mode)' :
                mode === 'G' ? 'HAR Generator (G mode)' :
                    'HAR Runner (R mode)';

        console.log(`\nLaunching ${label}...\n`);
        await runOnce(script);

    }
})();
