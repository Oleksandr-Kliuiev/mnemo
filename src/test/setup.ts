import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'

// jsdom's Blob does not survive fake-indexeddb's structured clone; Node's Blob does (browsers store Blobs natively).
globalThis.Blob = NodeBlob as unknown as typeof Blob
