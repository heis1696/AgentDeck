import { withFileLock, withStorageTransaction } from '../../src/main/persistence'
import type { TaskStore } from '../../src/main/store'

withStorageTransaction('typecheck-only', () => 42)
// @ts-expect-error Native async callbacks cannot hold a synchronous transaction.
withStorageTransaction('typecheck-only', async () => 42)
// @ts-expect-error Promise-returning callbacks are rejected even without async syntax.
withFileLock('typecheck-only', () => Promise.resolve(42))
declare const store: TaskStore
// @ts-expect-error Task views expire synchronously and cannot escape through await.
store.transaction(async (tx) => tx.list())
