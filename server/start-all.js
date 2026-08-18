#!/usr/bin/env node
/**
 * JARVIS Mission Control - Startup
 *
 * Starts the Mission Control server. The DeepSeek-Harness bridge runs inside
 * dsh as a plugin (integrations/deepseek-harness/dsh-plugin-mission-control),
 * so there is no separate bridge process to launch here.
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('JARVIS Mission Control — starting server...');

const server = spawn('node', [path.join(__dirname, 'index.js')], {
    stdio: 'inherit',
    env: { ...process.env }
});

server.on('error', (err) => {
    console.error('[Server] Failed to start:', err);
});

process.on('SIGINT', () => {
    console.log('\nShutting down Mission Control...');
    server.kill();
    process.exit(0);
});

process.on('SIGTERM', () => {
    server.kill();
    process.exit(0);
});
