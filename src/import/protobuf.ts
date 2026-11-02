/**
 * Minimal reader for the protobuf wire format, enough for the messages Anki stores in its
 * collection (notetype, template, field and deck configs) and in packages (meta, media list).
 * Fields are read by number; unknown ones are kept but ignored, so newer Anki versions still parse.
 */

export type ProtoValue = number | Uint8Array

/** Field number → values in the order they appear (repeated fields have several). */
export type ProtoMessage = Map<number, ProtoValue[]>

const utf8 = new TextDecoder()

export function decodeProto(buf: Uint8Array): ProtoMessage {
  const msg: ProtoMessage = new Map()
  let pos = 0
  // Values above 2^53 lose precision; none of the fields we read get that large.
  const varint = (): number => {
    let value = 0
    let scale = 1
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) throw new RangeError('protobuf: truncated varint')
      const b = buf[pos++]
      value += (b & 0x7f) * scale
      if (b < 0x80) return value
      scale *= 128
    }
    throw new RangeError('protobuf: varint too long')
  }
  const take = (n: number): Uint8Array => {
    if (pos + n > buf.length) throw new RangeError('protobuf: truncated field')
    const out = buf.subarray(pos, pos + n)
    pos += n
    return out
  }
  while (pos < buf.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (field === 0) throw new RangeError('protobuf: invalid field number')
    let value: ProtoValue
    switch (wire) {
      case 0:
        value = varint()
        break
      case 1:
        value = take(8)
        break
      case 2:
        value = take(varint())
        break
      case 5:
        value = take(4)
        break
      default:
        throw new RangeError(`protobuf: unsupported wire type ${wire}`)
    }
    const list = msg.get(field)
    if (list) list.push(value)
    else msg.set(field, [value])
  }
  return msg
}

/** For scalar fields the last occurrence wins, as in protobuf. */
function last(msg: ProtoMessage, field: number): ProtoValue | undefined {
  const list = msg.get(field)
  return list?.[list.length - 1]
}

export function protoHas(msg: ProtoMessage, field: number): boolean {
  return msg.has(field)
}

/** Unsigned varint field (uint32/uint64, enums, non-negative int64). */
export function protoUint(msg: ProtoMessage, field: number, fallback = 0): number {
  const v = last(msg, field)
  return typeof v === 'number' ? v : fallback
}

export function protoBool(msg: ProtoMessage, field: number): boolean {
  return protoUint(msg, field) !== 0
}

export function protoBytes(msg: ProtoMessage, field: number): Uint8Array | undefined {
  const v = last(msg, field)
  return v instanceof Uint8Array ? v : undefined
}

export function protoString(msg: ProtoMessage, field: number): string {
  const v = protoBytes(msg, field)
  return v ? utf8.decode(v) : ''
}

export function protoMessage(msg: ProtoMessage, field: number): ProtoMessage | undefined {
  const v = protoBytes(msg, field)
  return v ? decodeProto(v) : undefined
}

/** Repeated embedded messages. */
export function protoMessages(msg: ProtoMessage, field: number): ProtoMessage[] {
  const out: ProtoMessage[] = []
  for (const v of msg.get(field) ?? []) if (v instanceof Uint8Array) out.push(decodeProto(v))
  return out
}
