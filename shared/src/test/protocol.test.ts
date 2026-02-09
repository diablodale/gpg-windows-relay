/**
 * Unit tests for shared protocol utilities
 * These test the pure functions in shared/protocol.ts
 */

import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    encodeProtocolData,
    decodeProtocolData,
    sanitizeForLog,
    extractErrorMessage,
    parseSocketFile,
    extractNextCommand,
    determineNextState,
} from '../protocol';

// Test helper for creating buffers
function createBuffer(text: string): Buffer {
    return Buffer.from(text, 'latin1');
}

describe('Protocol Utilities', () => {
    describe('Latin1 Encoding/Decoding', () => {
        it('encodeProtocolData converts string to Buffer with latin1', () => {
            const input = 'HELLO\n';
            const result = encodeProtocolData(input);
            assert.ok(Buffer.isBuffer(result), 'Result should be a Buffer');
            assert.strictEqual(result.toString('latin1'), input, 'Round-trip encoding should preserve data');
        });

        it('decodeProtocolData converts Buffer back to string', () => {
            const input = Buffer.from('BYE\n', 'latin1');
            const result = decodeProtocolData(input);
            assert.strictEqual(result, 'BYE\n', 'Decoded string should match original');
        });

        it('encodeProtocolData and decodeProtocolData round-trip correctly', () => {
            const testCases = [
                'simple\n',
                'with spaces \n',
                'OK\n',
                'ERR 123 error message\n',
                'INQUIRE DATA\n'
            ];

            testCases.forEach(testCase => {
                const encoded = encodeProtocolData(testCase);
                const decoded = decodeProtocolData(encoded);
                assert.strictEqual(decoded, testCase, `Round-trip failed for: ${JSON.stringify(testCase)}`);
            });
        });
    });

    describe('Logging Utilities', () => {
        it('sanitizeForLog shows first word and byte count', () => {
            const input = 'KEYINFO D27BB288411333745EE1B194FBC6162A92775BA4 - - 0 P';
            const result = sanitizeForLog(input);
            assert.ok(result.includes('KEYINFO'), 'Should contain first word');
            assert.ok(result.includes('more bytes'), 'Should indicate byte count');
            assert.strictEqual(result.length < input.length, true, 'Should be shorter than input');
        });

        it('sanitizeForLog handles single-word input', () => {
            const input = 'OK';
            const result = sanitizeForLog(input);
            assert.ok(result.includes('OK'), 'Should contain the word');
        });

        it('sanitizeForLog handles newline-delimited data', () => {
            const input = 'DATA\nmultiple\nlines';
            const result = sanitizeForLog(input);
            assert.ok(result.includes('DATA'), 'Should extract first word');
        });
    });

    describe('Error Extraction', () => {
        it('extractErrorMessage gets message from Error objects', () => {
            const error = new Error('Connection refused');
            const result = extractErrorMessage(error);
            assert.strictEqual(result, 'Connection refused');
        });

        it('extractErrorMessage uses fallback for non-Error values', () => {
            const result = extractErrorMessage('string error', 'Fallback');
            assert.strictEqual(result, 'string error');
        });

        it('extractErrorMessage uses default fallback when provided', () => {
            const result = extractErrorMessage(null, 'Default message');
            assert.strictEqual(result, 'Default message');
        });

        it('extractErrorMessage handles error with code property', () => {
            const error = { code: 'ECONNREFUSED', message: 'Connection refused' } as any;
            const result = extractErrorMessage(error);
            assert.ok(result.includes('Connection refused') || result.includes('ECONNREFUSED'));
        });
    });

    describe('Socket File Parsing', () => {
        it('parseSocketFile extracts port and nonce from socket data', () => {
            const portStr = '12345';
            const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
            const socketData = Buffer.concat([
                Buffer.from(portStr, 'utf-8'),
                Buffer.from('\n', 'utf-8'),
                nonce
            ]);

            const result = parseSocketFile(socketData);
            assert.strictEqual(result.port, 12345, 'Port should be parsed correctly');
            assert.deepStrictEqual(result.nonce, nonce, 'Nonce should match');
        });

        it('parseSocketFile throws on invalid format (no newline)', () => {
            const invalidData = Buffer.from('12345_no_newline_here', 'utf-8');
            assert.throws(() => parseSocketFile(invalidData), /no newline found/);
        });

        it('parseSocketFile throws on invalid port', () => {
            const invalidData = Buffer.concat([
                Buffer.from('not_a_number\n', 'utf-8'),
                Buffer.alloc(16)
            ]);
            assert.throws(() => parseSocketFile(invalidData), /Invalid port/);
        });

        it('parseSocketFile throws on invalid nonce length', () => {
            const invalidData = Buffer.concat([
                Buffer.from('12345\n', 'utf-8'),
                Buffer.alloc(8) // Wrong length
            ]);
            assert.throws(() => parseSocketFile(invalidData), /Invalid nonce length/);
        });
    });

    describe('Command Extraction', () => {
        it('extractNextCommand extracts command in SEND_COMMAND state', () => {
            const buffer = 'KEYINFO D27BB288411333745EE1B194FBC6162A92775BA4 - - 0 P\n';
            const result = extractNextCommand(buffer, 'SEND_COMMAND');
            assert.strictEqual(result.command, buffer);
            assert.strictEqual(result.remaining, '');
        });

        it('extractNextCommand keeps remaining data after command', () => {
            const buffer = 'KEYINFO cmd\nNEXT line\n';
            const result = extractNextCommand(buffer, 'SEND_COMMAND');
            assert.strictEqual(result.command, 'KEYINFO cmd\n');
            assert.strictEqual(result.remaining, 'NEXT line\n');
        });

        it('extractNextCommand returns null when no newline found', () => {
            const buffer = 'incomplete command';
            const result = extractNextCommand(buffer, 'SEND_COMMAND');
            assert.strictEqual(result.command, null);
            assert.strictEqual(result.remaining, buffer);
        });

        it('extractNextCommand extracts inquire data in INQUIRE_DATA state', () => {
            const buffer = 'D some data\nD more data\nEND\nOK\n';
            const result = extractNextCommand(buffer, 'INQUIRE_DATA');
            assert.ok(result.command, 'Command should be extracted');
            assert.ok(result.command.includes('END\n'), 'Command should include END marker');
            assert.strictEqual(result.remaining, 'OK\n', 'Remaining buffer should have OK response');
        });
    });

    describe('State Determination', () => {
        it('determineNextState: SEND_COMMAND with OK response moves to SEND_COMMAND', () => {
            const result = determineNextState('OK\n', 'SEND_COMMAND');
            assert.strictEqual(result, 'SEND_COMMAND');
        });

        it('determineNextState: SEND_COMMAND with INQUIRE moves to INQUIRE_DATA', () => {
            const result = determineNextState('INQUIRE PASSPHRASE\n', 'SEND_COMMAND');
            assert.strictEqual(result, 'INQUIRE_DATA');
        });

        it('determineNextState: WAIT_RESPONSE with OK moves to SEND_COMMAND', () => {
            const result = determineNextState('OK\n', 'WAIT_RESPONSE');
            assert.strictEqual(result, 'SEND_COMMAND');
        });

        it('determineNextState: INQUIRE_DATA closes with OK', () => {
            const result = determineNextState('OK\n', 'INQUIRE_DATA');
            assert.strictEqual(result, 'SEND_COMMAND');
        });

        it('determineNextState: ERR response stays in same state for retry', () => {
            const result = determineNextState('ERR 123 error\n', 'SEND_COMMAND');
            assert.strictEqual(result, 'SEND_COMMAND');
        });
    });
});
