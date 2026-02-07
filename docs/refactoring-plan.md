# Refactoring Plan: Shared Utilities + Unit Testing

**Status**: 📋 Planning Complete  
**Started**: 2026-02-07  
**Target Completion**: TBD  
**Last Updated**: 2026-02-07

## Overview

Extract ~200 lines of duplicate code into shared utilities and enable 80-90% unit test coverage through pure function extraction and optional dependency injection. All changes are backward compatible.

### Goals

1. ✅ Eliminate duplicate code (sanitizeForLog, log, error extraction, latin1 encoding)
2. ✅ Extract pure protocol parsing functions for immediate testability
3. ✅ Add optional dependency injection (backward compatible)
4. ✅ Enable unit testing without VS Code runtime for core logic
5. ✅ Fix BUGBUG: request-proxy write errors should destroy socket

### Key Decisions

- **Backward Compatibility**: Optional `deps` parameter defaults to real implementations
- **Write Error Handling**: Both extensions destroy socket on write failure (socket 'close' event handles cleanup)
- **Pure Functions First**: Extract protocol parsing for immediate 80% coverage without mocking
- **ICommandExecutor**: Enables testing entire request-proxy state machine without VS Code

---

## Phase 1: Shared Utilities Foundation

**Goal**: Create shared modules for protocol encoding, logging, and pure parsing functions.  
**Dependencies**: None  
**Estimated Effort**: 4-6 hours

### 1.1 Create Shared Type Definitions

**File**: `shared/types.ts`

- [ ] Create shared/types.ts
- [ ] Define `LogConfig` interface
- [ ] Define `IFileSystem` interface
- [ ] Define `ISocketFactory` interface
- [ ] Define `ICommandExecutor` interface
- [ ] Define `IServerFactory` interface
- [ ] Add JSDoc comments for all interfaces

**Verification**: TypeScript compiles without errors

### 1.2 Implement Protocol Utilities

**File**: `shared/protocol.ts`

- [ ] Create shared/protocol.ts
- [ ] Implement `encodeProtocolData(str: string): Buffer` (latin1)
- [ ] Implement `decodeProtocolData(buffer: Buffer): string` (latin1)
- [ ] Extract & implement `sanitizeForLog(str: string): string` from both files
- [ ] Extract & implement `log(config: LogConfig, message: string): void` from both files
- [ ] Implement `extractErrorMessage(error: unknown, fallback?: string): string`
- [ ] Extract & implement `parseSocketFile(data: Buffer): { port: number; nonce: Buffer }`
  - From agent-proxy/src/services/agentProxy.ts lines 79-102
- [ ] Extract & implement `extractNextCommand(buffer: string, state: ClientState): { command: string | null; remaining: string }`
  - From request-proxy/src/services/requestProxy.ts lines 219-239
- [ ] Extract & implement `determineNextState(response: string, currentState: string): ClientState`
  - From request-proxy/src/services/requestProxy.ts lines 271-277
- [ ] Add JSDoc comments for all exported functions
- [ ] Add input validation and error handling

**Verification**:

- TypeScript compiles without errors
- All functions are pure (no side effects)

---

## Phase 2: Request-Proxy VS Code Command Wrapper

**Goal**: Wrap VS Code commands in ICommandExecutor for testability.  
**Dependencies**: Phase 1.1 (ICommandExecutor interface)  
**Estimated Effort**: 1-2 hours

### 2.1 Create Command Executor Wrapper

**File**: `request-proxy/src/services/commandExecutor.ts`

- [ ] Create commandExecutor.ts
- [ ] Implement `VSCodeCommandExecutor` class
- [ ] Implement `connectAgent()` method (wraps `_gpg-agent-proxy.connectAgent`)
- [ ] Implement `sendCommands()` method (wraps `_gpg-agent-proxy.sendCommands`)
- [ ] Implement `disconnectAgent()` method (wraps `_gpg-agent-proxy.disconnectAgent`)
- [ ] Add proper TypeScript type assertions for command results
- [ ] Export class from module

**Verification**:

- TypeScript compiles without errors
- Class implements ICommandExecutor interface correctly

---

## Phase 3: Update Agent-Proxy

**Goal**: Replace duplicates with shared utilities and add optional dependency injection.  
**Dependencies**: Phase 1 complete  
**Estimated Effort**: 4-5 hours

### 3.1 Update AgentProxy Class Structure

**File**: `agent-proxy/src/services/agentProxy.ts`

- [ ] Import shared utilities (`sanitizeForLog`, `log`, `extractErrorMessage`, `parseSocketFile`, `encodeProtocolData`, `decodeProtocolData`)
- [ ] Import shared types (`LogConfig`, `IFileSystem`, `ISocketFactory`)
- [ ] Define `AgentProxyDeps` interface
- [ ] Update `AgentProxyConfig` to extend `LogConfig`
- [ ] Add private fields: `socketFactory`, `fileSystem`
- [ ] Update constructor to accept optional `deps` parameter
- [ ] Initialize dependencies with defaults (backward compatible):
  - `socketFactory` defaults to `{ createConnection: net.createConnection }`
  - `fileSystem` defaults to `{ existsSync: fs.existsSync, readFileSync: fs.readFileSync }`

### 3.2 Replace Duplicate Code

- [ ] Remove local `sanitizeForLog()` function (lines ~327-332)
- [ ] Remove local `log()` function (lines ~337-341)
- [ ] Replace all `sanitizeForLog()` calls with imported version
- [ ] Replace all `log()` calls with imported version
- [ ] Replace error extraction patterns with `extractErrorMessage()`:
  - [ ] Line ~147 in connectAgent catch
  - [ ] Line ~248 in sendCommands write callback
  - [ ] Line ~250 in sendCommands catch
  - [ ] Line ~290 in disconnectAgent catch
  - [ ] Any other occurrences

### 3.3 Use Injected Dependencies

- [ ] Replace `fs.existsSync()` with `this.fileSystem.existsSync()` (constructor, line ~30)
- [ ] Replace `fs.readFileSync()` with `this.fileSystem.readFileSync()` (line ~77)
- [ ] Replace `net.createConnection()` with `this.socketFactory.createConnection()` (line ~145)
- [ ] Replace socket file parsing (lines ~79-102) with `parseSocketFile(fileBuffer)`
- [ ] Replace `chunk.toString('latin1')` with `decodeProtocolData(chunk)` (line ~191)
- [ ] Replace any `Buffer.from(..., 'latin1')` with `encodeProtocolData()` if present

**Verification**:

- TypeScript compiles without errors
- No duplicate function definitions
- All `toString('latin1')` and `Buffer.from(..., 'latin1')` replaced
- Extension still works with defaults (no behavior change)

---

## Phase 4: Update Request-Proxy

**Goal**: Replace duplicates with shared utilities, add dependency injection, fix BUGBUG.  
**Dependencies**: Phase 1, Phase 2 complete  
**Estimated Effort**: 5-6 hours

### 4.1 Update RequestProxy Function Structure

**File**: `request-proxy/src/services/requestProxy.ts`

- [ ] Import shared utilities (`sanitizeForLog`, `log`, `extractErrorMessage`, `extractNextCommand`, `determineNextState`, `encodeProtocolData`, `decodeProtocolData`)
- [ ] Import shared types (`LogConfig`, `IFileSystem`, `IServerFactory`, `ICommandExecutor`)
- [ ] Import `VSCodeCommandExecutor` from local commandExecutor.ts
- [ ] Define `RequestProxyDeps` interface
- [ ] Update `RequestProxyConfig` to extend `LogConfig`
- [ ] Update `startRequestProxy()` signature to accept optional `deps` parameter
- [ ] Initialize dependencies with defaults (backward compatible):
  - `commandExecutor` defaults to `new VSCodeCommandExecutor()`
  - `serverFactory` defaults to `{ createServer: net.createServer }`
  - `fileSystem` defaults to `{ existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, chmodSync: fs.chmodSync, unlinkSync: fs.unlinkSync }`

### 4.2 Replace Duplicate Code

- [ ] Remove local `sanitizeForLog()` function (lines ~38-43)
- [ ] Remove local `log()` function (lines ~338-342)
- [ ] Replace all `sanitizeForLog()` calls with imported version
- [ ] Replace all `log()` calls with imported version
- [ ] Replace error extraction patterns with `extractErrorMessage()`:
  - [ ] Line ~99 in readable handler catch
  - [ ] Line ~168 in writeToClient
  - [ ] Line ~286 in disconnectAgent catch
  - [ ] Any other occurrences

### 4.3 Use Injected Dependencies

- [ ] Replace `net.createServer()` with `serverFactory.createServer()` (line ~75)
- [ ] Replace all `fs.existsSync()` with `fileSystem.existsSync()`
- [ ] Replace all `fs.mkdirSync()` with `fileSystem.mkdirSync()`
- [ ] Replace all `fs.chmodSync()` with `fileSystem.chmodSync()`
- [ ] Replace all `fs.unlinkSync()` with `fileSystem.unlinkSync()`
- [ ] Replace `vscode.commands.executeCommand()` calls with `commandExecutor` methods:
  - [ ] Line ~200 connectToAgent(): use `commandExecutor.connectAgent()`
  - [ ] Lines ~260-264 waitResponse(): use `commandExecutor.sendCommands()`
  - [ ] Line ~295 disconnectAgent(): use `commandExecutor.disconnectAgent()`

### 4.4 Extract Pure Protocol Functions

- [ ] Replace command extraction logic (lines ~219-239) with `extractNextCommand(session.buffer, session.state)`
- [ ] Update to use returned `{ command, remaining }` object
- [ ] Replace state determination logic (lines ~271-277) with `determineNextState(response, session.state)`
- [ ] Replace `Buffer.from(data, 'latin1')` with `encodeProtocolData(data)` (line ~146)
- [ ] Replace `chunk.toString('latin1')` with `decodeProtocolData(chunk)` (line ~221)

### 4.5 Fix BUGBUG: Write Error Handling

**File**: `request-proxy/src/services/requestProxy.ts`  
**Location**: `writeToClient()` function (lines ~144-153)

- [ ] Remove BUGBUG comment
- [ ] Add `session.socket.destroy(err)` in error callback
- [ ] Update comment to explain: "Destroy socket on write error; 'close' event will call disconnectAgent()"

**Verification**:

- TypeScript compiles without errors
- No duplicate function definitions
- All `toString('latin1')` and `Buffer.from(..., 'latin1')` replaced
- All VS Code command calls go through commandExecutor
- Socket destroyed on write error
- Extension still works with defaults (no behavior change)

---

## Phase 5: Update Extension Entry Points

**Goal**: Update extension.ts files to use shared utilities.  
**Dependencies**: Phase 3, Phase 4 complete  
**Estimated Effort**: 1-2 hours

### 5.1 Update Agent-Proxy Extension

**File**: `agent-proxy/src/extension.ts`

- [ ] Import `extractErrorMessage` from shared/protocol
- [ ] Replace error message extraction (line ~253) with `extractErrorMessage(error)`
- [ ] Replace any other error extraction patterns
- [ ] Verify AgentProxy instantiation uses defaults (no deps parameter)
- [ ] Update configuration interface if needed to extend LogConfig

**Verification**: Extension activates without errors

### 5.2 Update Request-Proxy Extension

**File**: `request-proxy/src/extension.ts`

- [ ] Import `extractErrorMessage` from shared/protocol
- [ ] Import `VSCodeCommandExecutor` from services/commandExecutor
- [ ] Replace error message extraction (lines ~63, ~66, etc.) with `extractErrorMessage(error)`
- [ ] Update `startRequestProxy()` call to explicitly pass `new VSCodeCommandExecutor()` (or use defaults)
- [ ] Update configuration interface if needed to extend LogConfig

**Verification**: Extension activates without errors

---

## Phase 6: Testing Infrastructure

**Goal**: Create unit tests for pure functions and integration tests with mocks.  
**Dependencies**: Phase 1-5 complete  
**Estimated Effort**: 6-8 hours

### 6.1 Setup Test Environment

- [ ] Install jest: `npm install --save-dev jest @types/jest ts-jest`
- [ ] Configure jest in package.json
- [ ] Add test scripts to package.json: `"test"`, `"test:watch"`, `"test:coverage"`
- [ ] Create jest.config.js with moduleNameMapper for @shared paths
- [ ] Add test/ directories to .gitignore exclusions

### 6.2 Create Test Helpers

**File**: `shared/test/helpers.ts`

- [ ] Create shared/test/helpers.ts
- [ ] Implement `MockFileSystem` class
- [ ] Implement `MockSocketFactory` class
- [ ] Implement `MockCommandExecutor` class
- [ ] Implement `MockSocket` class with event emitter
- [ ] Implement `MockServer` class
- [ ] Export all mocks

### 6.3 Unit Tests: Shared Protocol Functions

**File**: `shared/test/protocol.test.ts`

- [ ] Test `sanitizeForLog()`:
  - [ ] Single word input
  - [ ] Multi-word input
  - [ ] Input with newlines
  - [ ] Empty string
- [ ] Test `extractErrorMessage()`:
  - [ ] Error object
  - [ ] String
  - [ ] Unknown type
  - [ ] With fallback
- [ ] Test `encodeProtocolData()` / `decodeProtocolData()`:
  - [ ] Round-trip conversion
  - [ ] Binary data preservation
  - [ ] Empty string
- [ ] Test `parseSocketFile()`:
  - [ ] Valid socket file (port + 16-byte nonce)
  - [ ] Invalid format (missing newline)
  - [ ] Invalid port number
  - [ ] Short nonce
- [ ] Test `extractNextCommand()`:
  - [ ] SEND_COMMAND: single command with newline
  - [ ] SEND_COMMAND: multiple commands buffered
  - [ ] SEND_COMMAND: incomplete command (no newline)
  - [ ] INQUIRE_DATA: D block with END
  - [ ] INQUIRE_DATA: incomplete block (no END)
- [ ] Test `determineNextState()`:
  - [ ] INQUIRE response → INQUIRE_DATA state
  - [ ] OK response → SEND_COMMAND state
  - [ ] ERR response → SEND_COMMAND state
  - [ ] INQUIRE at start of line vs middle

**Target**: 100% coverage for pure functions

### 6.4 Integration Tests: Agent-Proxy

**File**: `agent-proxy/src/test/agentProxy.test.ts`

- [ ] Test AgentProxy with mocked dependencies:
  - [ ] Constructor validates socket path
  - [ ] connectAgent() reads socket file and connects
  - [ ] connectAgent() sends nonce
  - [ ] connectAgent() waits for greeting
  - [ ] sendCommands() writes to socket
  - [ ] sendCommands() accumulates response
  - [ ] disconnectAgent() sends BYE and destroys socket
  - [ ] Socket close event cleans up session
  - [ ] Socket error event logs appropriately

**Target**: 70-80% coverage with mocks

### 6.5 Integration Tests: Request-Proxy

**File**: `request-proxy/src/test/requestProxy.test.ts`

- [ ] Test state machine with MockCommandExecutor:
  - [ ] Initial connection → SEND_COMMAND state
  - [ ] Simple command flow (no INQUIRE)
  - [ ] INQUIRE response → INQUIRE_DATA state
  - [ ] D block + END → back to SEND_COMMAND
  - [ ] Multiple commands in buffer
  - [ ] Socket close triggers disconnectAgent
  - [ ] Write error destroys socket

**Target**: 70-80% coverage with mocks

**Verification**:

- All tests pass: `npm test`
- Coverage reports generated
- No flaky tests (run multiple times)

---

## Phase 7: Configuration & Documentation

**Goal**: Update build config, TypeScript paths, and documentation.  
**Dependencies**: Phase 1-6 complete  
**Estimated Effort**: 2-3 hours

### 7.1 TypeScript Configuration

**File**: `tsconfig.json`

- [ ] Add shared/ to `include` array
- [ ] Configure `paths` mapping for @shared if desired
- [ ] Verify `rootDir` includes all source folders
- [ ] Ensure `outDir` is correct
- [ ] Test compilation: `npx tsc --noEmit`

### 7.2 Build Configuration

**File**: `package.json`

- [ ] Verify build script includes shared/ folder
- [ ] Test watch mode picks up shared/ changes
- [ ] Test package script bundles shared code into both .vsix files
- [ ] Add test scripts if not done in Phase 6.1
- [ ] Run full build: `npm run build`
- [ ] Create packages: `npm run package`

### 7.3 Update Repository Documentation

**File**: `.github/copilot-instructions.md`

- [ ] Add "Shared Utilities" section:
  - [ ] Describe shared/protocol.ts purpose
  - [ ] Describe shared/types.ts purpose
  - [ ] Document import paths
  - [ ] Note: all protocol encoding must use latin1
- [ ] Add "Testing" section:
  - [ ] Pure functions in shared/protocol.ts
  - [ ] Optional dependency injection via deps parameter
  - [ ] Default behavior unchanged (real implementations)
  - [ ] How to run tests: `npm test`
  - [ ] Mock helpers location
- [ ] Add "Dependency Injection" section:
  - [ ] When to use: testing only
  - [ ] Available interfaces: IFileSystem, ISocketFactory, ICommandExecutor, etc.
  - [ ] Production code uses defaults
- [ ] Update "When Editing" section:
  - [ ] Reference shared utilities for common operations
  - [ ] Add tests for new protocol logic
  - [ ] Socket write errors always destroy sockets

**File**: `README.md`

- [ ] Add "Testing" section with basic test commands
- [ ] Link to docs/refactoring-plan.md (this file)
- [ ] Update architecture description to mention shared utilities

**Verification**:

- Documentation is accurate and up-to-date
- All links work
- Instructions are clear

---

## Phase 8: Final Verification & Cleanup

**Goal**: Comprehensive testing and code cleanup.  
**Dependencies**: All phases complete  
**Estimated Effort**: 3-4 hours

### 8.1 Build Verification

- [ ] Clean build: `rm -rf out/ pack/` then `npm run build`
- [ ] No TypeScript errors: `npx tsc --noEmit`
- [ ] No linting errors: `npm run lint` (if configured)
- [ ] Watch mode works: `npm run watch` and edit a file
- [ ] Packages build: `npm run package` creates both .vsix files
- [ ] Inspect .vsix contents: verify shared/ code is bundled

### 8.2 Code Quality Checks

- [ ] No remaining `toString('latin1')` outside shared/protocol.ts:
  ```bash
  grep -r "toString('latin1')" agent-proxy/ request-proxy/ --exclude-dir=node_modules
  ```
- [ ] No remaining `Buffer.from(..., 'latin1')` outside shared/protocol.ts:
  ```bash
  grep -r "Buffer.from.*'latin1'" agent-proxy/ request-proxy/ --exclude-dir=node_modules
  ```
- [ ] No remaining `error instanceof Error ? error.message : String(error)` outside shared/protocol.ts:
  ```bash
  grep -r "instanceof Error.*message.*String" agent-proxy/ request-proxy/ --exclude-dir=node_modules
  ```
- [ ] No duplicate function definitions (sanitizeForLog, log)
- [ ] All BUGBUG comments resolved or documented
- [ ] All TODO comments reviewed

### 8.3 Runtime Testing (Manual)

- [ ] Start agent-proxy extension in debug mode
- [ ] Start request-proxy extension in debug mode
- [ ] Verify both extensions activate successfully
- [ ] Check status bar shows correct state
- [ ] Run GPG operation: `gpg --sign test.txt`
- [ ] Verify operation completes successfully
- [ ] Check logs show sanitized output (no raw binary)
- [ ] Verify socket write errors destroy socket (artificially trigger)
- [ ] Test multiple concurrent operations
- [ ] Test disconnect/reconnect scenarios
- [ ] Verify no memory leaks (check session cleanup)

### 8.4 Test Coverage Review

- [ ] Run coverage report: `npm run test:coverage`
- [ ] Verify coverage targets:
  - [ ] shared/protocol.ts: >95% coverage
  - [ ] agent-proxy/src/services/agentProxy.ts: >70% coverage
  - [ ] request-proxy/src/services/requestProxy.ts: >70% coverage
- [ ] Identify untested edge cases
- [ ] Add tests for any critical gaps

### 8.5 Performance Verification

- [ ] Measure extension activation time (should be unchanged)
- [ ] Measure GPG operation latency (should be unchanged)
- [ ] Verify no performance regressions

### 8.6 Final Code Review

- [ ] Review all changed files for:
  - [ ] Consistent code style
  - [ ] Proper error handling
  - [ ] Appropriate logging
  - [ ] Clear comments
  - [ ] No console.log() calls
- [ ] Check all exports are intentional
- [ ] Verify all imports are necessary
- [ ] Remove any dead code

**Verification**: All items checked, no issues found

---

## Success Criteria

- [ ] ✅ All duplicate code eliminated (~200 lines)
- [ ] ✅ Shared utilities created (protocol.ts, types.ts)
- [ ] ✅ Pure protocol functions extracted
- [ ] ✅ Optional dependency injection implemented
- [ ] ✅ VSCodeCommandExecutor wrapper created
- [ ] ✅ BUGBUG fixed (write errors destroy socket)
- [ ] ✅ Unit tests written (80-90% coverage target)
- [ ] ✅ Integration tests written with mocks
- [ ] ✅ All tests pass
- [ ] ✅ Documentation updated
- [ ] ✅ No behavior changes (backward compatible)
- [ ] ✅ Both extensions work in production
- [ ] ✅ Build and package successfully

---

## Metrics

### Code Changes

- **Lines Removed**: ~200 (duplicates)
- **Lines Added**: ~600 (shared utils + tests + interfaces)
- **Net Change**: +400 lines (with significant value add)
- **Files Created**: 8-10 new files
- **Files Modified**: 6-8 existing files

### Test Coverage

- **Before**: 0% (no tests)
- **Target**: 80-90% for protocol logic
- **Pure Functions**: 100% coverage
- **Integration**: 70-80% coverage with mocks

### Time Estimate

- **Phase 1**: 4-6 hours
- **Phase 2**: 1-2 hours
- **Phase 3**: 4-5 hours
- **Phase 4**: 5-6 hours
- **Phase 5**: 1-2 hours
- **Phase 6**: 6-8 hours
- **Phase 7**: 2-3 hours
- **Phase 8**: 3-4 hours
- **Total**: 26-36 hours (3-5 days)

---

## Risk Mitigation

### Risks

1. **Breaking Changes**: Unintended behavior changes
   - Mitigation: Backward compatible defaults, comprehensive runtime testing

2. **Import Path Issues**: TypeScript can't resolve shared/ imports
   - Mitigation: Configure tsconfig.json paths mapping early (Phase 7.1)

3. **Build/Packaging**: Shared code not bundled into .vsix
   - Mitigation: Verify package contents after Phase 7.2

4. **Test Flakiness**: Race conditions in async tests
   - Mitigation: Use deterministic mocks, avoid real timers

5. **Performance Regression**: Added abstraction layers slow things down
   - Mitigation: Performance verification in Phase 8.5

### Rollback Plan

If critical issues are found:

1. Revert to main branch
2. Create feature branch for refactoring
3. Fix issues identified
4. Re-test thoroughly before merge

---

## Notes

- Mark items complete by changing `- [ ]` to `- [x]`
- Add notes/issues below each phase as needed
- Update "Last Updated" date at top when making progress
- Move status from "Planning Complete" → "In Progress" → "Complete" as work advances

### Open Questions

- Should we use path aliases (@shared) or relative imports (../../../shared)?
- Do we need integration tests in CI/CD pipeline?
- Should mock helpers be in shared/test or each extension's test folder?

### Future Enhancements (Out of Scope)

- Abstract socket I/O with ISocket interface (enables full socket testing)
- Extract socket write utilities or make that part of future ISocket refactoring
- Extract timeout wrapper utility
- Create ProtocolDataAccumulator class for buffer management
- Add performance benchmarks
- Add E2E tests with real GPG operations
