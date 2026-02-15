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

    describe('Binary Data Handling (GPG Agent Responses)', () => {
        it('encodeProtocolData round-trips all latin1 byte values (0-255)', () => {
            // Create a string with all 256 byte values
            const bytes: number[] = [];
            for (let i = 0; i < 256; i++) {
                bytes.push(i);
            }
            const binary = String.fromCharCode(...bytes);

            const encoded = encodeProtocolData(binary);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, binary, 'All byte values should round-trip correctly');

            // Verify each byte
            for (let i = 0; i < 256; i++) {
                assert.strictEqual(decoded.charCodeAt(i), i, `Byte ${i} should be preserved`);
            }
        });

        it('handles high-byte values (128-255) common in binary data', () => {
            // Simulate GPG signature data with high bytes
            const highBytes = Buffer.from([
                0xC0, 0xDE, 0xBA, 0xBE, 0xCA, 0xFE, 0xBE, 0xEF
            ]);
            const input = highBytes.toString('latin1');

            const encoded = encodeProtocolData(input);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, input, 'High bytes should round-trip correctly');
            assert.deepStrictEqual(
                Buffer.from(decoded, 'latin1'),
                highBytes,
                'Should recreate original buffer'
            );
        });

        it('handles null bytes in binary data (edge case)', () => {
            // Create binary data with null bytes
            const binaryData = String.fromCharCode(0x01, 0x00, 0x02, 0x00, 0x03);

            const encoded = encodeProtocolData(binaryData);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, binaryData, 'Null bytes should be preserved');
            assert.strictEqual(decoded.length, 5, 'Length should include null bytes');
        });

        it('handles all 0xFF bytes (full saturation)', () => {
            const allFF = String.fromCharCode(0xFF, 0xFF, 0xFF, 0xFF);

            const encoded = encodeProtocolData(allFF);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, allFF, 'Should handle all 0xFF bytes');
            assert.strictEqual(decoded.length, 4);
        });

        it('handles realistic GPG signature response with binary and ASCII mixed', () => {
            // Simulate a D block containing signature data
            // Format: D <binary_data>
            const signatureBytes = Buffer.from([0x30, 0x45, 0x02, 0x20, 0xAB, 0xCD, 0xEF, 0x01]);
            const dataCommand = 'D ' + signatureBytes.toString('latin1') + '\n';

            const encoded = encodeProtocolData(dataCommand);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, dataCommand, 'D block with binary data should round-trip');

            // Extract signature bytes back out
            const parts = decoded.split(' ');
            assert.strictEqual(parts[0], 'D', 'Command should be D');
            const recoveredSignature = Buffer.from(parts.slice(1).join(' ').trim(), 'latin1');
            assert.deepStrictEqual(recoveredSignature, signatureBytes, 'Signature bytes should be recoverable');
        });

        it('handles random binary data sequences (simulating GPG output)', () => {
            // Generate pseudo-random binary data (deterministic for testing)
            const randomBytes: number[] = [];
            let seed = 12345;
            for (let i = 0; i < 64; i++) {
                seed = (seed * 1103515245 + 12345) >>> 0; // Unsigned to avoid overflow issues
                randomBytes.push((seed / 65536) % 256 | 0); // Ensure integer
            }

            const binaryString = String.fromCharCode(...randomBytes);
            const dataBlock = 'D ' + binaryString + '\n';

            const encoded = encodeProtocolData(dataBlock);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, dataBlock, 'Random binary sequence should survive round-trip');

            // Verify the binary was not corrupted by checking the buffer directly
            const encodedBuffer = Buffer.from(encoded);
            const expectedBuffer = Buffer.from(dataBlock, 'latin1');
            assert.deepStrictEqual(encodedBuffer, expectedBuffer, 'Buffer representation should match exactly');
        });

        it('sanitizeForLog handles binary data safely without corruption', () => {
            // Binary data that might appear in responses
            const binaryData = String.fromCharCode(0xAB, 0xCD, 0xEF, 0x12, 0x34);
            const input = 'SIGDATA ' + binaryData;

            // sanitizeForLog should not corrupt the data, just truncate for logging
            const sanitized = sanitizeForLog(input);

            // Should start with the first word
            assert.ok(sanitized.startsWith('SIGDATA'), 'Should start with first word');
            // Long input should be truncated
            if (input.length > 50) {
                assert.strictEqual(sanitized.length < input.length, true, 'Should be truncated for logging');
            }
        });

        it('handles large binary responses (e.g., exported keys)', () => {
            // Simulate a large key export (1KB of binary data)
            const largeData: number[] = [];
            for (let i = 0; i < 1024; i++) {
                largeData.push((i * 7) % 256); // Pseudo-random 1KB
            }

            const binaryString = String.fromCharCode(...largeData);
            const response = 'D ' + binaryString + '\nEND\nOK\n';

            const encoded = encodeProtocolData(response);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded.length, response.length, 'Full length should be preserved');
            assert.strictEqual(decoded, response, 'Large binary response should survive round-trip');
        });
    });
});
