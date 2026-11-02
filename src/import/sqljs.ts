import type { SqlJsStatic } from 'sql.js'
// Same bytes as sql-wasm-browser.wasm, which pairs with the "browser" build Vite picks for 'sql.js'.
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

let wasmBinary: ArrayBuffer | null = null
let loading: Promise<SqlJsStatic> | null = null

function toArrayBuffer(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

/** Hand over the wasm bytes directly (tests, or a host that already has them). Call before loadSqlJs(). */
export function setSqlWasmBinary(binary: Uint8Array | ArrayBuffer): void {
  wasmBinary = toArrayBuffer(binary)
}

function isNode(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string'
}

/** Node (vitest): read the wasm from node_modules. The specifiers are hidden from the bundler on purpose. */
async function readNodeWasm(): Promise<ArrayBuffer> {
  const fsId = 'node:fs'
  const moduleId = 'node:module'
  const fs = (await import(/* @vite-ignore */ fsId)) as typeof import('node:fs')
  const { createRequire } = (await import(/* @vite-ignore */ moduleId)) as typeof import('node:module')
  return toArrayBuffer(fs.readFileSync(createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm')))
}

/** Lazy-load sql.js (SQLite compiled to wasm). Loaded on first use, then cached. */
export function loadSqlJs(): Promise<SqlJsStatic> {
  if (!loading) {
    loading = (async () => {
      const { default: initSqlJs } = await import('sql.js')
      const binary = wasmBinary ?? (isNode() ? await readNodeWasm() : null)
      return initSqlJs(binary ? { wasmBinary: binary } : { locateFile: () => wasmUrl })
    })()
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}
